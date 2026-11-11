"""One process per inference stage: release model memory between stages."""
import argparse
import json
from pathlib import Path


def separate(args):
    import numpy as np
    import soundfile as sf
    import torch
    from mrx import MRX
    torch.set_num_threads(4)
    model = MRX().eval()
    model.load_state_dict(torch.load(args.models / "mrx.pth", map_location="cpu", weights_only=True))
    data, rate = sf.read(args.input, dtype="float32", always_2d=True)
    if rate != 44100:
        raise ValueError("MRX input must be 44.1 kHz")
    count = len(data)
    speech = np.zeros_like(data)
    background = np.zeros_like(data)
    # 10 s windows, 1 s context on each side. This bounds memory on 16 GB Macs.
    block, context = rate * 10, rate
    with torch.inference_mode():
        for start in range(0, count, block):
            end = min(count, start + block)
            left, right = max(0, start - context), min(count, end + context)
            chunk = data[left:right]
            if len(chunk) < 8192:
                chunk = np.pad(chunk, ((0, 8192 - len(chunk)), (0, 0)))
            tensor = torch.from_numpy(chunk.T.copy())
            output = model(tensor).numpy()
            # Official SOURCE_NAMES order is music, speech, sfx.
            begin, finish = start - left, end - left
            speech[start:end] = output[1, :, begin:finish].T
            background[start:end] = (output[0, :, begin:finish] + output[2, :, begin:finish]).T
            print(json.dumps({"percent": end / count * 100}), flush=True)
    sf.write(args.output / "speech.wav", speech, rate, subtype="PCM_16")
    sf.write(args.output / "background-raw.wav", background, rate, subtype="PCM_16")


def transcribe(args):
    import numpy as np
    from pywhispercpp.model import Model
    model_path = args.model or str(args.models / "small.en.bin")
    model = Model(model_path, n_threads=4, print_realtime=False, print_progress=False)
    audio = model._load_audio(str(args.input))
    language = "en"
    if args.multilingual:
        # Whisper auto-detection on the entire recording can choose the wrong
        # language when its opening is silent. Probe a few loud, separated
        # windows for language only, then still transcribe the complete audio
        # once so sparse speech keeps its original timestamps and context.
        sample_rate = 16000
        window_samples = min(sample_rate * 6, max(sample_rate, int(audio.size)))
        stride = max(1, window_samples // 2)
        starts = list(range(0, max(1, int(audio.size) - window_samples + 1), stride))
        final_start = max(0, int(audio.size) - window_samples)
        if not starts or starts[-1] != final_start:
            starts.append(final_start)
        candidates = []
        for start in starts:
            window = audio[start:min(int(audio.size), start + window_samples)]
            if window.size < sample_rate:
                window = np.pad(window, (0, sample_rate - window.size))
            rms = float(np.sqrt(np.mean(np.square(window, dtype=np.float64)))) if window.size else 0
            if rms > 0:
                candidates.append((rms, start, window))
        candidates.sort(key=lambda candidate: candidate[0], reverse=True)
        language_samples = []
        for candidate in candidates:
            _, start, _ = candidate
            if all(abs(start - other_start) >= window_samples for _, other_start, _ in language_samples):
                language_samples.append(candidate)
            if len(language_samples) == 3:
                break
        language_probabilities = {}
        for index, (_, _, window) in enumerate(language_samples):
            _, probabilities = model.auto_detect_language(window, n_threads=4)
            for code, probability in probabilities.items():
                language_probabilities[code] = language_probabilities.get(code, 0.0) + float(probability)
            print(json.dumps({"stage": "正在检测语种", "progress": min(5, (index + 1) / len(language_samples) * 5)}), flush=True)
        language = max(language_probabilities, key=language_probabilities.get) if language_probabilities else "auto"
        print(json.dumps({"stage": "已检测语种，正在识别整段音频", "progress": 5}), flush=True)

    def report_segment(segment):
        if args.multilingual and args.duration > 0:
            value = min(99, max(5, segment.t1 / 100 / args.duration * 100))
            print(json.dumps({"stage": "正在识别整段音频", "progress": value}), flush=True)

    # whisper.cpp treats detect_language=True as detection-only and returns
    # before decoding; keep it false even when language="auto" is needed.
    segments = model.transcribe(audio, language=language, detect_language=False,
                                new_segment_callback=report_segment, translate=False, no_context=True,
                                suppress_blank=True, max_len=160, split_on_word=True, temperature=0.0)
    result = [{"id": f"cue-{i}", "start": segment.t0 / 100, "end": segment.t1 / 100,
               "text": segment.text.strip(), "translation": "", "status": "draft"}
              for i, segment in enumerate(segments) if segment.text.strip() and segment.t1 > segment.t0]
    (args.output / "transcript.json").write_text(json.dumps(result, ensure_ascii=False))
    print(json.dumps({"progress": 100}), flush=True)


def tts(args):
    import soundfile as sf
    import sherpa_onnx
    root = args.models / "kokoro-multi-lang-v1_1"
    config = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
        kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=str(root / "model.onnx"), voices=str(root / "voices.bin"), tokens=str(root / "tokens.txt"),
            lexicon=f"{root / 'lexicon-us-en.txt'},{root / 'lexicon-zh.txt'}"),
        num_threads=4, debug=False, provider="cpu"),
        rule_fsts=','.join(str(root / name) for name in ("phone-zh.fst", "date-zh.fst", "number-zh.fst")))
    engine = sherpa_onnx.OfflineTts(config)
    cues = json.loads(args.input.read_text())
    for cue in cues:
        segments = cue.get("prosody", {}).get("segments") or [{"text": cue["translation"], "rate": 1.0, "pauseAfterMs": 0}]
        rendered = []
        sample_rate = None
        for segment in segments:
            audio = engine.generate(segment["text"], sid=args.voice, speed=float(segment.get("rate", 1.0)))
            sample_rate = audio.sample_rate
            rendered.append(audio.samples)
            pause = int(sample_rate * max(0, int(segment.get("pauseAfterMs", 0))) / 1000)
            if pause:
                import numpy as np
                rendered.append(np.zeros(pause, dtype="float32"))
        import numpy as np
        samples = np.concatenate(rendered) if rendered else np.zeros(1, dtype="float32")
        sf.write(args.output / f"{cue['id']}-natural.wav", samples, sample_rate or 24000, subtype="PCM_16")
        print(json.dumps({"cueId": cue["id"]}), flush=True)


parser = argparse.ArgumentParser()
parser.add_argument("stage", choices=["separate", "transcribe", "tts"])
parser.add_argument("--models", type=Path, required=True)
parser.add_argument("--input", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--voice", type=int, default=3)
parser.add_argument("--model", type=str, default="")
parser.add_argument("--multilingual", action="store_true")
parser.add_argument("--duration", type=float, default=0)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
globals()[args.stage](args)
