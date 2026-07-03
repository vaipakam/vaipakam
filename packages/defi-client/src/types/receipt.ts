/** Review receipt field shape shared by Basic and Advanced modes. */
export interface ReviewReceiptField {
  label: string;
  value: string;
  hint?: string;
}

export interface ReviewReceiptData {
  youReceive: ReviewReceiptField;
  youLock: ReviewReceiptField;
  youMayOwe: ReviewReceiptField;
  youCanLose: ReviewReceiptField;
  fees: ReviewReceiptField;
  whenEnds: ReviewReceiptField;
  technicalDetails?: ReviewReceiptField[];
}