/**
 * Placeholder app shell for the labs stub. Real marketing pages
 * (Landing, BuyVPFIMarketing, Overview, UserGuide-Basic,
 * Whitepaper, plus the public-read transparency stats UX that
 * uses ChainPicker from @vaipakam/ui) populate in Stage 4.
 */
export function App() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        textAlign: 'center',
      }}
    >
      <div style={{ maxWidth: 640 }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>
          Vaipakam Labs (stub)
        </h1>
        <p style={{ color: '#666', lineHeight: 1.6 }}>
          This site will host the Vaipakam marketing surface — landing
          page, Buy-VPFI explainer, Overview, basic User Guide, and
          Whitepaper — at <strong>labs.vaipakam.com</strong> (and
          eventually at <strong>www.vaipakam.com</strong> /{' '}
          <strong>vaipakam.com</strong> on cutover). Stage 4 of the
          source-tree refactor populates this from the marketing
          pages currently bundled into the in-app surface at{' '}
          <strong>defi.vaipakam.com</strong>.
        </p>
        <p style={{ color: '#999', fontSize: '0.9rem', marginTop: '1rem' }}>
          The in-app surface stays at{' '}
          <a href="https://defi.vaipakam.com">defi.vaipakam.com</a>.
        </p>
      </div>
    </main>
  );
}
