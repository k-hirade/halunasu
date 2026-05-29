const SAMPLE_TURNS = [
  "今日はどのような症状ですか。",
  "昨日から少し咳が出ています。",
  "発熱は高くなくて、息苦しさはありません。",
  "のどの違和感が少しあります。",
  "血圧のお薬はいつも通り飲んでいます。"
];

export class MockLiveStt {
  constructor() {
    this.sessions = new Map();
  }

  ensureSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        frameCount: 0,
        sampleIndex: 0
      });
    }

    return this.sessions.get(sessionId);
  }

  consumeFrame(sessionId) {
    const state = this.ensureSession(sessionId);
    state.frameCount += 1;

    const activeText = SAMPLE_TURNS[state.sampleIndex % SAMPLE_TURNS.length];
    const shouldEmitPartial = state.frameCount % 6 === 0;
    const shouldEmitFinal = state.frameCount % 18 === 0;

    let partial = null;
    let final = null;

    if (shouldEmitPartial) {
      partial = activeText.slice(0, Math.max(6, Math.floor(activeText.length * 0.6)));
    }

    if (shouldEmitFinal) {
      final = activeText;
      state.sampleIndex += 1;
    }

    return { partial, final };
  }

  reset(sessionId) {
    this.sessions.delete(sessionId);
  }
}
