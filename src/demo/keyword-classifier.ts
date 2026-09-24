import { Classification, ReplyClassifier } from '../inbound/reply-classifier';

/** Deterministic keyword classifier for tests and DEMO mode. */
export class KeywordClassifier implements ReplyClassifier {
  calls = 0;
  constructor(private readonly delayMs = 0) {}

  async classify(text: string): Promise<Classification> {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const t = text.toLowerCase();
    if (/\brecus|não aprovo/.test(t))
      return { decision: 'REJECTED', note: text };
    if (/\baprov|pode pagar/.test(t))
      return { decision: 'APPROVED', note: text };
    return { decision: 'UNCLEAR', note: text };
  }
}
