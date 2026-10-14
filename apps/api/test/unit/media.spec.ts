import {
  buildCuesFromScenes,
  chunkText,
  renderAss,
  renderSrt,
  STYLE_PRESETS,
  toAssTime,
  toSrtTime,
  wrapLines,
} from '@/modules/media/subtitle.service';
import { escapeFilterPath, parseLoudnormJson } from '@/modules/media/assembly.service';
import { evaluateQuality, type QualityControlInput } from '@/modules/media/quality-control.service';
import { type SubtitleStyle, type MediaProbeResult, DEFAULT_VIDEO_FORMAT } from '@shorts/contracts';

const STYLE: SubtitleStyle = { ...STYLE_PRESETS.default!, bottomMarginPercent: 22 };

describe('chunkText', () => {
  it('returns nothing for empty input', () => {
    expect(chunkText('', 24, 2)).toEqual([]);
    expect(chunkText('   ', 24, 2)).toEqual([]);
  });

  it('keeps short text as one chunk', () => {
    expect(chunkText('Baby Leo giggles', 24, 2)).toEqual(['Baby Leo giggles']);
  });

  it('splits on word boundaries within the budget', () => {
    const chunks = chunkText(
      'Baby Leo wakes up early and finds a tiny duckling hiding under the kitchen table today',
      20,
      2,
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40);
    expect(chunks.join(' ')).toBe(
      'Baby Leo wakes up early and finds a tiny duckling hiding under the kitchen table today',
    );
  });

  it('never splits a word, even one longer than a whole line', () => {
    const chunks = chunkText('supercalifragilisticexpialidocious hi', 10, 1);
    expect(chunks[0]).toBe('supercalifragilisticexpialidocious');
  });
});

describe('wrapLines', () => {
  it('respects the line budget', () => {
    const lines = wrapLines('the quick brown fox jumps over', 12, 2);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it('keeps a single short line intact', () => {
    expect(wrapLines('hello there', 24, 2)).toEqual(['hello there']);
  });
});

describe('buildCuesFromScenes', () => {
  const scenes = [
    { voiceover: 'Baby Leo wakes up early.', durationSeconds: 5 },
    { voiceover: '', durationSeconds: 3 },
    { voiceover: 'And finds a tiny duckling hiding under the kitchen table.', durationSeconds: 8 },
  ];

  it('skips scenes with no narration', () => {
    const cues = buildCuesFromScenes(scenes, STYLE);
    // Nothing should be scheduled inside the silent 5s-8s window.
    const inSilence = cues.filter((cue) => cue.startSeconds >= 5 && cue.endSeconds <= 8);
    expect(inSilence).toEqual([]);
  });

  it('numbers cues consecutively from 1', () => {
    const cues = buildCuesFromScenes(scenes, STYLE);
    expect(cues.map((cue) => cue.index)).toEqual(cues.map((_, i) => i + 1));
  });

  it('keeps cues in chronological, non-overlapping order', () => {
    const cues = buildCuesFromScenes(scenes, STYLE);
    for (let i = 1; i < cues.length; i += 1) {
      // Each cue must start no earlier than the previous one *ended*; comparing
      // start times alone let two captions share the screen unnoticed.
      expect(cues[i]!.startSeconds).toBeGreaterThanOrEqual(cues[i - 1]!.endSeconds);
    }
  });

  it('never lets a short trailing chunk spill into the next scene', () => {
    // Real case: a 4.46 s scene whose text splits into a long chunk and one short
    // word. Stretching the word to the minimum used to push it 0.19 s past the
    // scene end, over the next scene's first caption.
    const tight = [
      {
        voiceover: 'Ducky waddles over, flapping his wings into a funny shape.',
        durationSeconds: 4.46,
      },
      {
        voiceover: 'Now they take turns, giggling at every silly new animal.',
        durationSeconds: 4.96,
      },
    ];
    const cues = buildCuesFromScenes(tight, STYLE);
    for (let i = 1; i < cues.length; i += 1) {
      expect(cues[i]!.startSeconds).toBeGreaterThanOrEqual(cues[i - 1]!.endSeconds);
    }
    const firstSceneCues = cues.filter((cue) => cue.startSeconds < 4.46);
    expect(Math.max(...firstSceneCues.map((cue) => cue.endSeconds))).toBeLessThanOrEqual(4.46);
  });

  it('keeps captions up until the end of each spoken scene', () => {
    const cues = buildCuesFromScenes(scenes, STYLE);
    expect(cues.at(-1)?.endSeconds).toBe(16);
    const firstScene = cues.filter((cue) => cue.startSeconds < 5);
    expect(firstScene.at(-1)?.endSeconds).toBe(5);
  });

  it('starts the first cue at the beginning of the video', () => {
    const cues = buildCuesFromScenes(scenes, STYLE);
    expect(cues[0]?.startSeconds).toBe(0);
  });

  it('gives every cue a positive, readable duration', () => {
    const cues = buildCuesFromScenes(scenes, STYLE);
    for (const cue of cues) {
      expect(cue.endSeconds).toBeGreaterThan(cue.startSeconds);
      expect(cue.endSeconds - cue.startSeconds).toBeGreaterThanOrEqual(0.69);
    }
  });

  it('uppercases text when the style asks for it', () => {
    const shouty: SubtitleStyle = { ...STYLE, uppercase: true };
    const cues = buildCuesFromScenes([{ voiceover: 'hello there', durationSeconds: 3 }], shouty);
    expect(cues[0]?.text).toBe('HELLO THERE');
  });

  it('produces no cues at all for a silent video', () => {
    expect(buildCuesFromScenes([{ voiceover: '', durationSeconds: 10 }], STYLE)).toEqual([]);
  });
});

describe('subtitle time formatting', () => {
  it('formats ASS timestamps with centiseconds', () => {
    expect(toAssTime(0)).toBe('0:00:00.00');
    expect(toAssTime(65.25)).toBe('0:01:05.25');
    expect(toAssTime(3661.5)).toBe('1:01:01.50');
  });

  it('formats SRT timestamps with milliseconds and a comma', () => {
    expect(toSrtTime(0)).toBe('00:00:00,000');
    expect(toSrtTime(65.25)).toBe('00:01:05,250');
  });

  it('never emits a negative timestamp', () => {
    expect(toAssTime(-5)).toBe('0:00:00.00');
  });
});

describe('renderAss', () => {
  const cues = buildCuesFromScenes(
    [{ voiceover: 'Baby Leo finds a duckling', durationSeconds: 4 }],
    STYLE,
  );
  const ass = renderAss(cues, STYLE, { width: 1080, height: 1920 });

  it('declares the real frame size so pixel values are meaningful', () => {
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
  });

  it('keeps captions clear of the Shorts UI via a vertical margin', () => {
    // 22% of 1920 = 422px.
    expect(ass).toContain(',422,1');
  });

  it('emits a Dialogue line per cue', () => {
    expect(ass.match(/^Dialogue:/gm)?.length).toBe(cues.length);
  });

  it('escapes braces, which would otherwise be ASS override blocks', () => {
    const tricky = renderAss(
      [{ index: 1, startSeconds: 0, endSeconds: 2, text: 'look {at} this' }],
      STYLE,
      { width: 1080, height: 1920 },
    );
    expect(tricky).toContain('\\{at\\}');
  });
});

describe('renderSrt', () => {
  it('renders standard SRT blocks', () => {
    const srt = renderSrt([{ index: 1, startSeconds: 0, endSeconds: 2.5, text: 'Hello' }]);
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:02,500\nHello\n');
  });
});

describe('parseLoudnormJson', () => {
  it('extracts the measurement block from noisy ffmpeg output', () => {
    const stderr = `
frame= 100 fps=0.0
[Parsed_loudnorm_0 @ 0x1] 
{
  "input_i" : "-23.5",
  "input_tp" : "-5.2",
  "input_lra" : "7.3",
  "input_thresh" : "-33.8",
  "output_i" : "-14.0",
  "target_offset" : "0.5"
}
`;
    expect(parseLoudnormJson(stderr)).toMatchObject({ input_i: '-23.5', target_offset: '0.5' });
  });

  it('returns null when there is no JSON', () => {
    expect(parseLoudnormJson('no measurement here')).toBeNull();
  });

  it('returns null when the block is incomplete, rather than half-applying it', () => {
    expect(parseLoudnormJson('{"input_i": "-23.5"}')).toBeNull();
  });

  it('returns null on malformed JSON instead of throwing', () => {
    expect(parseLoudnormJson('{ this is not json }')).toBeNull();
  });
});

describe('escapeFilterPath', () => {
  it('escapes filter-graph separators', () => {
    expect(escapeFilterPath('/tmp/a:b/captions.ass')).toBe('/tmp/a\\:b/captions.ass');
  });
});

describe('evaluateQuality', () => {
  const goodProbe: MediaProbeResult = {
    durationSeconds: 32,
    sizeBytes: 4_500_000,
    formatName: 'mov,mp4',
    video: { codec: 'h264', width: 1080, height: 1920, fps: 30, bitRate: 2_000_000 },
    audio: { codec: 'aac', sampleRate: 48_000, channels: 2, bitRate: 192_000 },
  };

  const baseInput: QualityControlInput = {
    probe: goodProbe,
    fileExists: true,
    format: DEFAULT_VIDEO_FORMAT,
    scenes: [
      { index: 0, durationSeconds: 8, hasAsset: true },
      { index: 1, durationSeconds: 12, hasAsset: true },
      { index: 2, durationSeconds: 12, hasAsset: true },
    ],
    integratedLufs: -14.2,
    subtitlesEnabled: true,
    subtitleCueCount: 6,
    title: 'Baby Leo and the Duckling',
    description: 'A tiny story about a big discovery in the kitchen.',
    safetyVerdict: 'ALLOW',
    duplicateDetected: false,
    assetLicenses: ['AI_GENERATED', 'DERIVED_OWN'],
  };

  const check = (report: ReturnType<typeof evaluateQuality>, id: string) =>
    report.checks.find((c) => c.id === id);

  it('passes a well-formed video', () => {
    const report = evaluateQuality(baseInput);
    expect(report.passed).toBe(true);
    expect(report.failureCount).toBe(0);
  });

  it('fails fast and explains when the file is missing', () => {
    const report = evaluateQuality({ ...baseInput, fileExists: false, probe: null });
    expect(report.passed).toBe(false);
    expect(check(report, 'file_present')?.status).toBe('FAIL');
    // No point reporting resolution when there is nothing to measure.
    expect(check(report, 'resolution')).toBeUndefined();
  });

  it('fails on the wrong resolution', () => {
    const report = evaluateQuality({
      ...baseInput,
      probe: { ...goodProbe, video: { ...goodProbe.video!, width: 1920, height: 1080 } },
    });
    expect(check(report, 'resolution')?.status).toBe('FAIL');
    expect(check(report, 'aspect_ratio')?.status).toBe('FAIL');
    expect(report.passed).toBe(false);
  });

  it('fails a video that is too long for a Short', () => {
    const report = evaluateQuality({ ...baseInput, probe: { ...goodProbe, durationSeconds: 95 } });
    expect(check(report, 'duration')?.status).toBe('FAIL');
  });

  it('allows a small tolerance around the duration bounds', () => {
    const report = evaluateQuality({
      ...baseInput,
      probe: { ...goodProbe, durationSeconds: 14.2 },
    });
    expect(check(report, 'duration')?.status).toBe('PASS');
  });

  it('fails when there is no audio track', () => {
    const report = evaluateQuality({ ...baseInput, probe: { ...goodProbe, audio: null } });
    expect(check(report, 'audio_present')?.status).toBe('FAIL');
  });

  it('fails on effectively silent audio', () => {
    const report = evaluateQuality({ ...baseInput, integratedLufs: -70 });
    expect(check(report, 'audio_loudness')?.status).toBe('FAIL');
  });

  it('warns, but does not fail, when loudness is merely off target', () => {
    const report = evaluateQuality({ ...baseInput, integratedLufs: -20 });
    expect(check(report, 'audio_loudness')?.status).toBe('WARN');
    expect(report.passed).toBe(true);
  });

  it('accepts codec aliases reported by ffprobe', () => {
    const report = evaluateQuality({
      ...baseInput,
      probe: {
        ...goodProbe,
        video: { ...goodProbe.video!, codec: 'avc1' },
        audio: { ...goodProbe.audio!, codec: 'aac_latm' },
      },
    });
    expect(check(report, 'video_codec')?.status).toBe('PASS');
    expect(check(report, 'audio_codec')?.status).toBe('PASS');
  });

  it('fails when a scene has no rendered asset', () => {
    const report = evaluateQuality({
      ...baseInput,
      scenes: [...baseInput.scenes.slice(0, 2), { index: 2, durationSeconds: 12, hasAsset: false }],
    });
    expect(check(report, 'scenes_present')?.status).toBe('FAIL');
  });

  it('fails on a degenerate scene', () => {
    const report = evaluateQuality({
      ...baseInput,
      scenes: [...baseInput.scenes, { index: 3, durationSeconds: 0.1, hasAsset: true }],
    });
    expect(check(report, 'scene_min_duration')?.status).toBe('FAIL');
  });

  it('fails when subtitles are enabled but absent', () => {
    const report = evaluateQuality({ ...baseInput, subtitleCueCount: 0 });
    expect(check(report, 'subtitles_present')?.status).toBe('FAIL');
  });

  it('does not check subtitles when they are disabled', () => {
    const report = evaluateQuality({
      ...baseInput,
      subtitlesEnabled: false,
      subtitleCueCount: 0,
    });
    expect(check(report, 'subtitles_present')).toBeUndefined();
    expect(report.passed).toBe(true);
  });

  it('fails without a title or description', () => {
    const report = evaluateQuality({ ...baseInput, title: '', description: null });
    expect(check(report, 'title_present')?.status).toBe('FAIL');
    expect(check(report, 'description_present')?.status).toBe('FAIL');
  });

  it('fails a safety-blocked video and only warns on a review flag', () => {
    expect(evaluateQuality({ ...baseInput, safetyVerdict: 'BLOCK' }).passed).toBe(false);

    const reviewed = evaluateQuality({ ...baseInput, safetyVerdict: 'REVIEW' });
    expect(check(reviewed, 'safety_verdict')?.status).toBe('WARN');
    expect(reviewed.passed).toBe(true);
  });

  it('fails a detected duplicate', () => {
    const report = evaluateQuality({ ...baseInput, duplicateDetected: true });
    expect(check(report, 'duplicate_check')?.status).toBe('FAIL');
  });

  it('fails when any asset has unestablished provenance', () => {
    const report = evaluateQuality({
      ...baseInput,
      assetLicenses: ['AI_GENERATED', 'UNKNOWN'],
    });
    expect(check(report, 'asset_licensing')?.status).toBe('FAIL');
    expect(report.passed).toBe(false);
  });

  it('counts failures and warnings accurately', () => {
    const report = evaluateQuality({
      ...baseInput,
      title: '',
      integratedLufs: -20,
      duplicateDetected: true,
    });
    expect(report.failureCount).toBe(2);
    expect(report.warningCount).toBe(1);
  });
});
