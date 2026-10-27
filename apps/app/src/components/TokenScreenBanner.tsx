/**
 * #2726 — the token-security screen's verdicts, as every accept review shows
 * them (the direct accept, the rental, the signed-offer fill). One banner, so
 * each review states a block, a warning or an unscreened network the same
 * way, from the same `useTokenScreen` state the signers compare against.
 */
import { copy } from '../content/copy';
import type { TokenScreen } from '../contracts/acceptTokenScreen';

export function TokenScreenBanner({
  screen,
  style,
}: {
  screen: TokenScreen;
  style?: React.CSSProperties;
}) {
  if (screen.blocked.length > 0) {
    return (
      <div className="banner banner-danger" role="alert" style={style}>
        <span className="banner-body">
          {screen.blocked
            .map((l) =>
              // An errored leg may still carry a STALE prior verdict in
              // `verdict`: report "couldn't check", never the stale text.
              l.errored || l.verdict === undefined
                ? copy.tokenSecurity.gateUnknown(l.leg)
                : copy.tokenSecurity.gateBlock(
                    l.leg,
                    (l.verdict.kind === 'block' ? l.verdict.reasons : []).join('; '),
                  ),
            )
            .join(' ')}
        </span>
        {screen.blocked.some((l) => l.errored) ? (
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: 8 }}
            onClick={screen.retry}
          >
            {copy.tokenSecurity.retry}
          </button>
        ) : null}
      </div>
    );
  }
  if (screen.warned.length > 0) {
    return (
      <div className="banner banner-warn" role="alert" style={style}>
        <span className="banner-body">
          {screen.warned
            .map((l) =>
              copy.tokenSecurity.gateWarn(
                l.leg,
                (l.verdict?.kind === 'warn' ? l.verdict.reasons : []).join('; '),
              ),
            )
            .join(' ')}
        </span>
      </div>
    );
  }
  if (screen.unsupported.length > 0) {
    return (
      <div className="banner banner-info" role="note" style={style}>
        <span className="banner-body">
          {screen.unsupported.map((l) => copy.tokenSecurity.gateUnsupported(l.leg)).join(' ')}
        </span>
      </div>
    );
  }
  return null;
}
