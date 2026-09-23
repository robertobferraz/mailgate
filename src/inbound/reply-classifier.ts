export interface Classification {
  decision: 'APPROVED' | 'REJECTED' | 'UNCLEAR';
  note: string;
}

export interface ReplyClassifier {
  classify(text: string): Promise<Classification>;
}

export const REPLY_CLASSIFIER = Symbol('REPLY_CLASSIFIER');
