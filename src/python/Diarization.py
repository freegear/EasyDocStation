import argparse
import os
import torch
import whisper
from pyannote.audio import Pipeline
from tqdm.auto import tqdm

STEPS = [
    "실행 환경 확인",
    "화자 분리 파이프라인 로드",
    "파이프라인 장치 이동",
    "오디오 화자 분리 실행",
    "화자 분리 결과 저장",
    "Whisper STT 모델 로드",
    "오디오 STT 변환 실행",
    "STT 텍스트 저장",
]


def _write_rttm_from_itertracks(annotation_like, output_path, uri):
    with open(output_path, "w", encoding="utf-8") as f:
        for segment, _, speaker in annotation_like.itertracks(yield_label=True):
            start = float(segment.start)
            duration = float(segment.end - segment.start)
            line = (
                f"SPEAKER {uri} 1 {start:.3f} {duration:.3f} "
                f"<NA> <NA> {speaker} <NA> <NA>"
            )
            f.write(line + "\n")


def _save_diarization_rttm(diarization_output, output_path, uri):
    if hasattr(diarization_output, "write_rttm"):
        with open(output_path, "w", encoding="utf-8") as f:
            diarization_output.write_rttm(f)
        return

    if hasattr(diarization_output, "to_rttm"):
        rttm_text = diarization_output.to_rttm()
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(rttm_text)
        return

    if hasattr(diarization_output, "speaker_diarization"):
        nested = diarization_output.speaker_diarization
        _save_diarization_rttm(nested, output_path, uri)
        return

    if hasattr(diarization_output, "itertracks"):
        _write_rttm_from_itertracks(diarization_output, output_path, uri)
        return

    raise TypeError(
        "지원하지 않는 diarization 결과 타입입니다. "
        "'write_rttm', 'to_rttm', 'speaker_diarization', 'itertracks' 중 하나가 필요합니다."
    )


def _format_seconds(seconds):
    total = int(seconds)
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def _load_rttm_segments(rttm_path):
    segments = []
    with open(rttm_path, "r", encoding="utf-8") as rttm:
        for line in rttm:
            parts = line.strip().split()
            if len(parts) < 8 or parts[0] != "SPEAKER":
                continue
            start = float(parts[3])
            duration = float(parts[4])
            speaker = parts[7]
            segments.append(
                {
                    "start": start,
                    "end": start + duration,
                    "speaker": speaker,
                }
            )
    return segments


def _resolve_speaker(start, end, diar_segments):
    best_speaker = "UNKNOWN_SPEAKER"
    best_overlap = 0.0
    for diar in diar_segments:
        overlap_start = max(start, diar["start"])
        overlap_end = min(end, diar["end"])
        overlap = max(0.0, overlap_end - overlap_start)
        if overlap > best_overlap:
            best_overlap = overlap
            best_speaker = diar["speaker"]
    return best_speaker


def _write_stt_transcript(stt_result, transcript_path, rttm_path):
    full_text = (stt_result.get("text") or "").strip()
    segments = stt_result.get("segments") or []
    diar_segments = _load_rttm_segments(rttm_path)

    with open(transcript_path, "w", encoding="utf-8") as txt:
        txt.write("# STT Transcript\n\n")
        if full_text:
            txt.write("## Full Text\n")
            txt.write(full_text + "\n\n")

        txt.write("## Segments\n")
        if not segments:
            txt.write("(세그먼트 정보 없음)\n")
            return

        for seg in segments:
            start_sec = float(seg.get("start", 0.0))
            end_sec = float(seg.get("end", 0.0))
            speaker = _resolve_speaker(start_sec, end_sec, diar_segments)
            line = (seg.get("text") or "").strip()
            txt.write(f"[{speaker}] {line}\n")


def _parse_args():
    parser = argparse.ArgumentParser(
        description="Audio diarization + STT transcript generator"
    )
    parser.add_argument(
        "-i",
        "--input",
        required=True,
        help="입력 오디오 파일 경로 (예: input.wav)",
    )
    return parser.parse_args()


def main():
    args = _parse_args()
    audio_path = args.input

    if not os.path.isfile(audio_path):
        raise FileNotFoundError(f"입력 파일을 찾을 수 없습니다: {audio_path}")

    input_dir = os.path.dirname(audio_path) or "."
    input_stem = os.path.splitext(os.path.basename(audio_path))[0]
    output_rttm_path = os.path.join(input_dir, f"{input_stem}.rttm")
    output_transcript_path = os.path.join(input_dir, f"{input_stem}.txt")
    hf_token = os.getenv("HF_TOKEN", "").strip()
    if not hf_token:
        raise RuntimeError("HF_TOKEN 환경변수가 필요합니다.")
    whisper_model_name = os.getenv("WHISPER_MODEL", "small")
    whisper_language = os.getenv("WHISPER_LANGUAGE", "ko")
    uri = input_stem

    progress_bar = None
    try:
        with tqdm(total=len(STEPS), unit="step", dynamic_ncols=True) as progress_bar:
            # 1. GPU(MPS) 사용 가능 여부 확인
            progress_bar.set_description(f"1/{len(STEPS)} {STEPS[0]}")
            device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
            progress_bar.update(1)
            progress_bar.write(f"사용 중인 장치: {device}")

            # 2. 파이프라인 로드
            progress_bar.set_description(f"2/{len(STEPS)} {STEPS[1]}")
            pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                token=hf_token,
            )
            progress_bar.update(1)

            # 3. 파이프라인을 사용 장치로 이동
            progress_bar.set_description(f"3/{len(STEPS)} {STEPS[2]}")
            pipeline.to(device)
            progress_bar.update(1)

            # 4. 오디오 처리
            progress_bar.set_description(f"4/{len(STEPS)} {STEPS[3]}")
            diarization = pipeline(audio_path)
            progress_bar.update(1)

            # 5. diarization 결과 저장
            progress_bar.set_description(f"5/{len(STEPS)} {STEPS[4]}")
            _save_diarization_rttm(diarization, output_rttm_path, uri)
            progress_bar.update(1)

            # 6. Whisper 모델 로드
            progress_bar.set_description(f"6/{len(STEPS)} {STEPS[5]}")
            stt_model = whisper.load_model(whisper_model_name)
            progress_bar.update(1)

            # 7. 오디오 STT 실행
            progress_bar.set_description(f"7/{len(STEPS)} {STEPS[6]}")
            stt_result = stt_model.transcribe(
                audio_path,
                language=whisper_language,
                fp16=False,
                verbose=False,
            )
            progress_bar.update(1)

            # 8. STT 텍스트 저장
            progress_bar.set_description(f"8/{len(STEPS)} {STEPS[7]}")
            _write_stt_transcript(stt_result, output_transcript_path, output_rttm_path)
            progress_bar.update(1)
            progress_bar.set_description("완료")

        print(
            "완료: "
            f"'{output_rttm_path}'(화자 분리), "
            f"'{output_transcript_path}'(STT 텍스트) 파일이 저장되었습니다."
        )
    except Exception as exc:
        if progress_bar is not None:
            progress_bar.write(f"오류가 발생했습니다: {exc}")
        else:
            print(f"오류가 발생했습니다: {exc}")
        raise


if __name__ == "__main__":
    main()
