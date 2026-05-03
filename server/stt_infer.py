#!/usr/bin/env python3
import json
import os
import sys
import tempfile
import importlib.util
import contextlib
from dataclasses import dataclass
from typing import Dict, List, Optional

import numpy as np

try:
    import librosa
except Exception as e:
    print(json.dumps({"ok": False, "error_code": "AUDIO_DECODE_FAILED", "error_message": f"librosa import failed: {e}"}))
    sys.exit(0)


def emit_event(payload: Dict):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


@dataclass
class Segment:
    start_sec: float
    end_sec: float
    speaker_label: str


def load_audio(path: str, sr: int = 16000):
    y, _ = librosa.load(path, sr=sr, mono=True)
    if y is None or len(y) == 0:
        raise RuntimeError("empty audio")
    peak = np.max(np.abs(y)) if len(y) else 0
    if peak > 0:
        y = y / peak
    return y, sr


def chunk_segments(duration_sec: float, chunk_sec: float = 25.0, overlap_sec: float = 2.5) -> List[Segment]:
    segs: List[Segment] = []
    start = 0.0
    idx = 0
    step = max(1.0, chunk_sec - overlap_sec)
    while start < duration_sec:
        end = min(duration_sec, start + chunk_sec)
        segs.append(Segment(start_sec=start, end_sec=end, speaker_label="SPEAKER_00"))
        idx += 1
        start += step
    return segs


def _load_rttm_segments(rttm_path: str) -> List[Segment]:
    out: List[Segment] = []
    if not os.path.exists(rttm_path):
        return out
    with open(rttm_path, "r", encoding="utf-8") as rttm:
        for line in rttm:
            parts = line.strip().split()
            if len(parts) < 8 or parts[0] != "SPEAKER":
                continue
            start = float(parts[3])
            duration = float(parts[4])
            speaker = parts[7]
            out.append(Segment(start_sec=start, end_sec=start + duration, speaker_label=speaker))
    out.sort(key=lambda s: s.start_sec)
    return out


def run_external_diarization(audio_path: str, hf_token: Optional[str]) -> Optional[List[Segment]]:
    default_script_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "src", "python", "Diarization.py")
    )
    script_path = os.getenv("DIARIZATION_SCRIPT_PATH", default_script_path)
    if not script_path or not os.path.exists(script_path):
        return None

    emit_event({"event": "progress", "progress": 2, "stage": "diarization_external_start"})
    try:
        spec = importlib.util.spec_from_file_location("external_diarization_module", script_path)
        if spec is None or spec.loader is None:
            emit_event({"event": "log", "stage": "diarization_external_failed", "error": "module spec load failed"})
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        diar_fn = getattr(module, "generate_diarization_rttm", None)
        if not callable(diar_fn):
            emit_event({
                "event": "log",
                "stage": "diarization_external_failed",
                "error": "generate_diarization_rttm not found",
            })
            return None

        hf_token_safe = str(hf_token or "").strip()
        if not hf_token_safe:
            emit_event({
                "event": "log",
                "stage": "diarization_external_failed",
                "error": "HF_TOKEN missing",
            })
            return None

        stem = os.path.splitext(os.path.basename(audio_path))[0]
        base_dir = os.path.dirname(audio_path) or "."
        rttm_path = os.path.join(base_dir, f"{stem}.rttm")
        dump_log_path = os.path.join(base_dir, f"{stem}.diarization.bridge.log")
        with open(dump_log_path, "a", encoding="utf-8") as dump_fp:
            dump_fp.write(f"\n===== diarization call start: {audio_path} =====\n")
            with contextlib.redirect_stdout(dump_fp), contextlib.redirect_stderr(dump_fp):
                diar_fn(
                    audio_path=audio_path,
                    hf_token=hf_token_safe,
                    output_rttm_path=rttm_path,
                    uri=stem,
                    debug=True,
                )
            dump_fp.write("===== diarization call end =====\n")
        emit_event({
            "event": "log",
            "stage": "diarization_external_log_dumped",
            "log_path": dump_log_path,
        })
        diar = _load_rttm_segments(rttm_path)
        if not diar:
            return None
        emit_event({
            "event": "progress",
            "progress": 4,
            "stage": "diarization_external_done",
            "segment_count": len(diar),
        })
        return postprocess_diarization(diar)
    except Exception as e:
        emit_event({
            "event": "log",
            "stage": "diarization_external_exception",
            "error": str(e)[:500],
        })
        return None


def run_diarization(audio_path: str, hf_token: Optional[str]) -> Optional[List[Segment]]:
    external_first = os.getenv("USE_EXTERNAL_DIARIZATION", "1").strip().lower() not in ("0", "false", "no")
    if external_first:
        external = run_external_diarization(audio_path, hf_token)
        if external:
            return external

    if not hf_token:
        return None
    try:
        import torch
        from pyannote.audio import Pipeline

        try:
            pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", token=hf_token)
        except TypeError:
            pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=hf_token)

        device = torch.device("cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu"))
        pipeline.to(device)
        diarization = pipeline(audio_path)
        out: List[Segment] = []
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            out.append(Segment(start_sec=float(turn.start), end_sec=float(turn.end), speaker_label=str(speaker)))
        if not out:
            return None
        out.sort(key=lambda s: s.start_sec)
        return postprocess_diarization(out)
    except Exception:
        return None


def postprocess_diarization(segments: List[Segment]) -> List[Segment]:
    if not segments:
        return segments

    # 1) Remove too-short noise segments
    filtered = [s for s in segments if (s.end_sec - s.start_sec) >= 0.25]
    if not filtered:
        filtered = segments

    # 2) Merge adjacent same-speaker segments with tiny gaps
    merged: List[Segment] = []
    max_gap = 0.40
    for seg in filtered:
        if not merged:
            merged.append(seg)
            continue
        prev = merged[-1]
        if prev.speaker_label == seg.speaker_label and (seg.start_sec - prev.end_sec) <= max_gap:
            prev.end_sec = max(prev.end_sec, seg.end_sec)
        else:
            merged.append(seg)

    # 3) Normalize speaker labels to SPEAKER_00, SPEAKER_01, ...
    speaker_map: Dict[str, str] = {}
    next_idx = 0
    normalized: List[Segment] = []
    for seg in merged:
        if seg.speaker_label not in speaker_map:
            speaker_map[seg.speaker_label] = f"SPEAKER_{next_idx:02d}"
            next_idx += 1
        normalized.append(Segment(seg.start_sec, seg.end_sec, speaker_map[seg.speaker_label]))
    return normalized


class GemmaTranscriber:
    def __init__(self, model_id: str):
        try:
            import torch
            from transformers import AutoProcessor, AutoModelForMultimodalLM
        except Exception as e:
            raise RuntimeError(f"transformers import failed: {e}")

        self.torch = torch
        try:
            self.processor = AutoProcessor.from_pretrained(model_id)
            self.model = AutoModelForMultimodalLM.from_pretrained(
                model_id,
                torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
                device_map="auto",
            )
        except Exception as e:
            raise RuntimeError(f"model load failed: {e}")

    def transcribe_segment(self, wav_path: str, language: str = "ko") -> str:
        prompt = {
            "ko": "다음 오디오를 한국어로 정확히 전사해줘. 군더더기 설명 없이 전사문만 출력해줘.",
            "en": "Transcribe this audio accurately. Output transcript only.",
            "ja": "この音声を正確に文字起こししてください。説明なしで本文のみ出力してください。",
            "zh": "请准确转写这段音频，仅输出转写文本。",
        }.get(language, "Transcribe this audio accurately. Output transcript only.")

        messages = [{
            "role": "user",
            "content": [
                {"type": "audio", "audio": wav_path},
                {"type": "text", "text": prompt},
            ],
        }]

        inputs = self.processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        ).to(self.model.device)

        outputs = self.model.generate(**inputs, max_new_tokens=512)
        decoded = self.processor.decode(outputs[0], skip_special_tokens=True)
        return decoded.strip()

    def summarize(self, transcript: str, language: str = "ko") -> str:
        prompt = {
            "ko": "다음 전사문을 회의록 형식으로 요약해줘. 안건, 결정사항, 액션아이템을 구분해줘.\n\n",
            "en": "Summarize transcript into meeting minutes with agenda, decisions, action items.\n\n",
            "ja": "以下を議事録形式で要約し、議題・決定事項・アクションアイテムを分けてください。\n\n",
            "zh": "请将以下转写整理为会议纪要，并区分议题、决定事项、行动项。\n\n",
        }.get(language, "Summarize transcript into meeting minutes.\n\n")

        messages = [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt + transcript[:120000]},
            ],
        }]

        inputs = self.processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        ).to(self.model.device)

        outputs = self.model.generate(**inputs, max_new_tokens=768)
        decoded = self.processor.decode(outputs[0], skip_special_tokens=True)
        return decoded.strip()


def main():
    if len(sys.argv) < 2:
        emit_event({"ok": False, "error_code": "BAD_REQUEST", "error_message": "payload path required"})
        return

    payload_path = sys.argv[1]
    with open(payload_path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    audio_path = payload.get("audioPath")
    if not audio_path or not os.path.exists(audio_path):
        emit_event({"ok": False, "error_code": "AUDIO_FILE_NOT_FOUND", "error_message": "audio file not found"})
        return

    language = payload.get("language", "ko")
    diarization_on = bool(payload.get("diarization", True))
    diarization_required = bool(payload.get("diarizationRequired", False))
    model_id = payload.get("modelId", "google/gemma-4-E4B-it")
    hf_token = payload.get("hfToken")

    try:
        y, sr = load_audio(audio_path, sr=16000)
    except Exception as e:
        emit_event({"ok": False, "error_code": "AUDIO_DECODE_FAILED", "error_message": str(e)})
        return

    duration = float(len(y) / sr)
    if duration <= 0:
        emit_event({"ok": False, "error_code": "AUDIO_DECODE_FAILED", "error_message": "invalid duration"})
        return

    diarized = run_diarization(audio_path, hf_token) if diarization_on else None
    if diarization_on and diarization_required and diarized is None:
        emit_event({
            "ok": False,
            "error_code": "DIARIZATION_FAILED",
            "error_message": "diarization required but failed",
        })
        return

    if diarized is None:
        diarized = chunk_segments(duration, chunk_sec=25.0, overlap_sec=2.5)

    try:
        transcriber = GemmaTranscriber(model_id)
    except Exception as e:
        emit_event({"ok": False, "error_code": "MODEL_LOAD_FAILED", "error_message": str(e)})
        return
    emit_event({"event": "progress", "progress": 5, "stage": "model_loaded"})

    segments_out: List[Dict] = []
    try:
        import soundfile as sf
    except Exception as e:
        emit_event({"ok": False, "error_code": "AUDIO_DECODE_FAILED", "error_message": f"soundfile import failed: {e}"})
        return

    total_segments = len(diarized)
    for i, seg in enumerate(diarized):
        s = max(0, int(seg.start_sec * sr))
        e = min(len(y), int(seg.end_sec * sr))
        if e <= s:
            continue
        piece = y[s:e]
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            sf.write(tmp_path, piece, sr)
            text = transcriber.transcribe_segment(tmp_path, language=language)
        except Exception as ex:
            emit_event({"ok": False, "error_code": "TRANSCRIPTION_FAILED", "error_message": str(ex)})
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
            return
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

        segments_out.append({
            "segment_index": i,
            "start_sec": round(seg.start_sec, 3),
            "end_sec": round(seg.end_sec, 3),
            "speaker_label": seg.speaker_label,
            "text": text,
            "confidence": 0.7,
        })
        emit_event({
            "event": "progress",
            "progress": int(((i + 1) / max(1, total_segments)) * 100),
            "stage": "transcribing",
            "current": i + 1,
            "total": total_segments,
            "speaker_label": seg.speaker_label,
        })

    full_transcript = "\n".join(
        f"[{s['speaker_label']}] {s['text']}" if s.get("speaker_label") else s["text"]
        for s in segments_out
    ).strip()

    try:
        summary = transcriber.summarize(full_transcript, language=language)
    except Exception as e:
        emit_event({"ok": False, "error_code": "SUMMARY_FAILED", "error_message": str(e)})
        return

    emit_event({
        "ok": True,
        "segments": segments_out,
        "full_transcript": full_transcript,
        "summary": summary,
        "diarization": {
            "required": diarization_required,
            "enabled": diarization_on,
            "used": bool(diarization_on and diarized is not None),
            "speaker_count": len(set([s.speaker_label for s in diarized])) if diarized else 0,
            "segment_count": len(diarized) if diarized else 0,
        },
    })


if __name__ == "__main__":
    main()
