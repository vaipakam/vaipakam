/**
 * The words each side's posting flow is written with. A borrower posts a
 * request (the `request.*` catalog); a lender posts an offer (`lendOffer.*`).
 * Only the lines whose meaning differs by side are keyed here; a line that
 * reads the same for both (a parse error, the expiry choices, the approval
 * wording) stays shared, so the two flows say one thing one way.
 */
import type { CopyKey } from '../copy/useCopy';
import type { PostSide } from './postModel';

export const POST_KEYS = {
  borrower: {
    formTitle: 'request.formTitle',
    openSummary: 'request.openSummary',
    openWhy: 'request.openWhy',
    amountLabel: 'request.amountLabel',
    collateralLabel: 'request.collateralLabel',
    durationNone: 'request.durationNone',
    expiryLabel: 'request.expiryLabel',
    expiryDaysLabel: 'request.expiryDaysLabel',
    errExpiryHigh: 'request.errExpiryHigh',
    errRateHigh: 'request.errRateHigh',
    interestLabel: 'request.interestLabel',
    fullTermOption: 'request.fullTermOption',
    partialOption: 'request.partialOption',
    optionsSummary: 'request.optionsSummary',
    optionsWhy: 'request.optionsWhy',
    summary: 'request.summary',
    review: 'request.review',
    cancelForm: 'request.cancelForm',
    edit: 'request.edit',
    blockShortfall: 'request.blockShortfall',
    blockRefused: 'request.blockRefused',
    blockUnread: 'request.blockUnread',
    changedVerdict: 'request.changedVerdict',
    stepSend: 'request.stepSend',
    dryRunRefused: 'request.dryRunRefused',
    stoppedAfterApproval: 'request.stoppedAfterApproval',
    termsNewer: 'request.termsNewer',
    legOffer: 'request.legOffer',
    legNoOffer: 'request.legNoOffer',
    noOffer: 'request.noOffer',
    postSummary: 'request.postSummary',
    postWhy: 'request.postWhy',
    feeSummary: 'accept.feeSummary',
    feeWhy: 'accept.feeWhy',
  },
  lender: {
    formTitle: 'lendOffer.formTitle',
    openSummary: 'lendOffer.openSummary',
    openWhy: 'lendOffer.openWhy',
    amountLabel: 'lendOffer.amountLabel',
    collateralLabel: 'lendOffer.collateralLabel',
    durationNone: 'lendOffer.durationNone',
    expiryLabel: 'lendOffer.expiryLabel',
    expiryDaysLabel: 'lendOffer.expiryDaysLabel',
    errExpiryHigh: 'lendOffer.errExpiryHigh',
    errRateHigh: 'lendOffer.errRateHigh',
    interestLabel: 'lendOffer.interestLabel',
    fullTermOption: 'lendOffer.fullTermOption',
    partialOption: 'lendOffer.partialOption',
    optionsSummary: 'lendOffer.optionsSummary',
    optionsWhy: 'lendOffer.optionsWhy',
    summary: 'lendOffer.summary',
    review: 'lendOffer.review',
    cancelForm: 'lendOffer.cancelForm',
    edit: 'lendOffer.edit',
    blockShortfall: 'lendOffer.blockShortfall',
    blockRefused: 'lendOffer.blockRefused',
    blockUnread: 'lendOffer.blockUnread',
    changedVerdict: 'lendOffer.changedVerdict',
    stepSend: 'lendOffer.stepSend',
    dryRunRefused: 'lendOffer.dryRunRefused',
    stoppedAfterApproval: 'lendOffer.stoppedAfterApproval',
    termsNewer: 'lendOffer.termsNewer',
    legOffer: 'lendOffer.legOffer',
    legNoOffer: 'lendOffer.legNoOffer',
    noOffer: 'lendOffer.noOffer',
    postSummary: 'lendOffer.postSummary',
    postWhy: 'lendOffer.postWhy',
    feeSummary: 'lendOffer.feeSummary',
    feeWhy: 'lendOffer.feeWhy',
  },
} as const satisfies Record<PostSide, Record<string, CopyKey>>;

/** The user-guide section on each side's risks, linked from the consent. */
export const RISK_GUIDE: Readonly<Record<PostSide, string>> = { borrower: 'borrow-risks', lender: 'lend-risks' };
