import { MessageCircle, ExternalLink } from 'lucide-react';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import './Discord.css';

// Canonical Vaipakam Discord invite. Keep in sync with any CHANGELOG
// entry when the invite URL is rotated (invites are renewable, so this
// occasionally gets refreshed by the community ops team).
const DISCORD_INVITE_URL = 'https://discord.gg/5dTYbQKm69';

/**
 * `/discord` — minimal redirect landing page. Its only purpose is to give
 * the community a short, memorable URL (`vaipakam.app/discord`) that
 * resolves to the current Discord invite link without baking the invite
 * token into every promo / doc / screenshot. Clicking the CTA opens the
 * invite in a new tab so the user keeps their Vaipakam session intact.
 */
export default function DiscordPage() {
  return (
    <>
      <Navbar />
      <main className="discord-page">
        <div className="container discord-wrap">
          <div className="discord-card">
            <div className="discord-icon">
              <MessageCircle size={36} />
            </div>
            <h1>Join the Vaipakam Discord</h1>
            <p className="discord-tagline">
              Chat with the core team, other lenders and borrowers, swap
              collateral-strategy notes, and get early signal on new
              deployments. Moderation follows the same non-custodial,
              no-KYC ethos as the protocol itself.
            </p>

            <a
              href={DISCORD_INVITE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary btn-lg discord-cta"
              aria-label="Open Vaipakam Discord invite in a new tab"
            >
              Join Discord
              <ExternalLink size={18} />
            </a>

            <p className="discord-fine-print">
              Opens <code>{DISCORD_INVITE_URL}</code> in a new tab. We never
              ask for wallet signatures, seed phrases, or KYC on Discord —
              anyone who DMs you claiming to is impersonating the team.
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
