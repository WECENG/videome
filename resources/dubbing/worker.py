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
    from pywhispercpp.model import Model
    model_path = args.model or str(args.models / "small.en.bin")
    model = Model(model_path, n_threads=4, print_realtime=False, print_progress=False)
    segments = []

    def report_segment(segment):
        segments.append(segment)
        if args.multilingual and args.duration > 0:
            value = min(99, max(0, segment.t1 / 100 / args.duration * 100))
            print(json.dumps({"progress": value}), flush=True)

    segments = model.transcribe(str(args.input), language="" if args.multilingual else "en", detect_language=args.multilingual,
                                new_segment_callback=report_segment, translate=False, no_context=True,
                                suppress_blank=True, max_len=160, split_on_word=True, temperature=0.0)
    result = [{"id": f"cue-{i}", "start": s.t0 / 100, "end": s.t1 / 100, "text": s.text.strip(), "translation": "", "status": "draft"}
              for i, s in enumerate(segments) if s.text.strip() and s.t1 > s.t0]
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
