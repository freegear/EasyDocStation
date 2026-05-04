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

    # 1) Remove too-short noise segments (강화)
    min_seg_sec = float(os.getenv("STT_MIN_SEGMENT_SEC", "0.9"))
    filtered = [s for s in segments if (s.end_sec - s.start_sec) >= min_seg_sec]
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


def compute_voice_embeddings(audio_path: str, segments: List[Segment]) -> Dict[str, List[float]]:
    """USE_VOICE_EMBEDDING=1 일 때 resemblyzer로 화자별 평균 임베딩 계산."""
    if os.getenv("USE_VOICE_EMBEDDING", "0").strip().lower() not in ("1", "true", "yes"):
        return {}
    try:
        from resemblyzer import VoiceEncoder, preprocess_wav
    except ImportError:
        emit_event({"event": "log", "stage": "voice_embedding_skip", "reason": "resemblyzer not installed"})
        return {}
    try:
        wav = preprocess_wav(audio_path)
        encoder = VoiceEncoder()
        sr = 16000

        speaker_wavs: Dict[str, list] = {}
        for seg in segments:
            if (seg.end_sec - seg.start_sec) < 1.0:
                continue
            start_s = int(seg.start_sec * sr)
            end_s = min(int(seg.end_sec * sr), len(wav))
            if end_s <= start_s:
                continue
            speaker_wavs.setdefault(seg.speaker_label, []).append(wav[start_s:end_s])

        embeddings: Dict[str, List[float]] = {}
        for label, wav_slices in speaker_wavs.items():
            embeds = []
            for ws in wav_slices:
                try:
                    embeds.append(encoder.embed_utterance(ws))
                except Exception:
                    pass
            if embeds:
                mean_emb = np.mean(embeds, axis=0)
                embeddings[label] = mean_emb.tolist()

        return embeddings
    except Exception as e:
        emit_event({"event": "log", "stage": "voice_embedding_error", "error": str(e)[:300]})
        return {}


class WhisperSegmentTranscriber:
    def __init__(self, model_name: str = "small"):
        try:
            import whisper
        except Exception as e:
            raise RuntimeError(f"whisper import failed: {e}")
        try:
            self.model = whisper.load_model(model_name)
        except Exception as e:
            raise RuntimeError(f"whisper model load failed: {e}")

    def transcribe_segment(self, wav_path: str, language: str = "ko") -> str:
        try:
            result = self.model.transcribe(
                wav_path,
                language=language,
                fp16=False,
                verbose=False,
            )
        except Exception as e:
            raise RuntimeError(f"whisper transcribe failed: {e}")
        return str((result or {}).get("text") or "").strip()

    def transcribe_full(self, audio_path: str, language: str = "ko") -> Dict:
        try:
            result = self.model.transcribe(
                audio_path,
                language=language,
                fp16=False,
                verbose=False,
            )
        except Exception as e:
            raise RuntimeError(f"whisper full transcribe failed: {e}")
        return result or {}


def is_low_energy(piece: np.ndarray) -> bool:
    if piece is None or len(piece) == 0:
        return True
    rms = float(np.sqrt(np.mean(np.square(piece.astype(np.float32)))))
    threshold = float(os.getenv("STT_MIN_RMS", "0.008"))
    return rms < threshold


def normalize_for_dedupe(text: str) -> str:
    t = str(text or "").strip().lower()
    if not t:
        return ""
    return " ".join(t.split())


def is_unwanted_transcript_text(text: str) -> bool:
    t = str(text or "").strip()
    if not t:
        return True
    bad_contains = [
        "오디오 파일이 제공되지",
        "오디오 파일을 업로드",
        "전사해 드리겠습니다",
        "군더더기 설명 없이 전사문만 출력",
        "다음 오디오를 한국어로 정확히 전사",
        "죄송합니다",
        "i cannot",
        "please upload",
    ]
    return any(k in t for k in bad_contains)


def resolve_speaker_label(diarized: Optional[List[Segment]], start_sec: float, end_sec: float) -> str:
    if not diarized:
        return "SPEAKER_00"
    best_label = "SPEAKER_00"
    best_overlap = 0.0
    for d in diarized:
        overlap_start = max(float(start_sec), float(d.start_sec))
        overlap_end = min(float(end_sec), float(d.end_sec))
        overlap = max(0.0, overlap_end - overlap_start)
        if overlap > best_overlap:
            best_overlap = overlap
            best_label = str(d.speaker_label or "SPEAKER_00")
    return best_label


class GemmaSummarizer:
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

    def summarize(self, transcript: str, language: str = "ko") -> str:
        prompt = {
            "ko": "다음 전사문을 회의록 형식으로 요약해줘. 첫 번째 줄에 반드시 '제목: [70자 이내 핵심 요약]' 형식으로 회의 제목을 작성하고, 그 다음 줄부터 안건, 결정사항, 액션아이템을 구분해줘.\n\n",
            "en": "Summarize transcript into meeting minutes. First line must be 'Title: [key summary in 70 chars or less]', then list agenda, decisions, action items.\n\n",
            "ja": "以下を議事録形式で要約してください。最初の行に必ず「タイトル: [70字以内の要約]」を記載し、その後に議題・決定事項・アクションアイテムを分けてください。\n\n",
            "zh": "请将以下转写整理为会议纪要。第一行必须写「标题: [70字以内核心摘要]」，之后区分议题、决定事项、行动项。\n\n",
        }.get(language, "Summarize transcript into meeting minutes. First line must be 'Title: [key summary in 70 chars or less]', then list agenda, decisions, action items.\n\n")

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

    diarized_for_embedding = diarized  # None이면 embedding 생략
    if diarized is None:
        diarized = chunk_segments(duration, chunk_sec=25.0, overlap_sec=2.5)

    # Voice embedding: 실제 diarization 결과가 있을 때만 계산
    speaker_embeddings: Dict = {}
    if diarized_for_embedding:
        speaker_embeddings = compute_voice_embeddings(audio_path, diarized_for_embedding)
        if speaker_embeddings:
            emit_event({"event": "log", "stage": "voice_embedding_done", "speaker_count": len(speaker_embeddings)})

    whisper_model = str(payload.get("whisperModel") or os.getenv("WHISPER_MODEL") or "large-v3")
    try:
        transcriber = WhisperSegmentTranscriber(whisper_model)
    except Exception as e:
        emit_event({"ok": False, "error_code": "MODEL_LOAD_FAILED", "error_message": str(e)})
        return
    emit_event({"event": "progress", "progress": 5, "stage": "whisper_loaded", "whisperModel": whisper_model})

    try:
        summarizer = GemmaSummarizer(model_id)
    except Exception as e:
        emit_event({"ok": False, "error_code": "MODEL_LOAD_FAILED", "error_message": str(e)})
        return
    emit_event({"event": "progress", "progress": 8, "stage": "gemma_loaded", "modelId": model_id})

    segments_out: List[Dict] = []
    try:
        import soundfile as sf
    except Exception as e:
        emit_event({"ok": False, "error_code": "AUDIO_DECODE_FAILED", "error_message": f"soundfile import failed: {e}"})
        return

    emit_event({"event": "progress", "progress": 12, "stage": "transcribing_full_start"})
    try:
        full_stt = transcriber.transcribe_full(audio_path, language=language)
    except Exception as ex:
        emit_event({"ok": False, "error_code": "TRANSCRIPTION_FAILED", "error_message": str(ex)})
        return
    emit_event({"event": "progress", "progress": 70, "stage": "transcribing_full_done"})

    whisper_segments = full_stt.get("segments") or []
    prev_norm_text = ""
    total_segments = max(1, len(whisper_segments))
    for i, seg in enumerate(whisper_segments):
        start_sec = float(seg.get("start", 0.0))
        end_sec = float(seg.get("end", 0.0))
        text = str(seg.get("text") or "").strip()

        if not text:
            continue
        if is_unwanted_transcript_text(text):
            continue

        norm = normalize_for_dedupe(text)
        if norm and norm == prev_norm_text:
            continue
        prev_norm_text = norm

        speaker_label = resolve_speaker_label(diarized, start_sec, end_sec)
        segments_out.append({
            "segment_index": i,
            "start_sec": round(start_sec, 3),
            "end_sec": round(end_sec, 3),
            "speaker_label": speaker_label,
            "text": text,
            "confidence": 0.7,
        })
        emit_event({
            "event": "progress",
            "progress": 70 + int(((i + 1) / total_segments) * 20),
            "stage": "speaker_mapping",
            "current": i + 1,
            "total": total_segments,
            "speaker_label": speaker_label,
        })

    full_transcript = "\n".join(
        f"[{s['speaker_label']}] {s['text']}" if s.get("speaker_label") else s["text"]
        for s in segments_out
    ).strip()

    try:
        summary = summarizer.summarize(full_transcript, language=language)
    except Exception as e:
        emit_event({"ok": False, "error_code": "SUMMARY_FAILED", "error_message": str(e)})
        return

    emit_event({
        "ok": True,
        "segments": segments_out,
        "full_transcript": full_transcript,
        "summary": summary,
        "speaker_embeddings": speaker_embeddings,
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
