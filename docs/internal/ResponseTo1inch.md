1. API Customer Enhanced Due DiligenceV2

Dear API Customer,
Thank you for taking the time to complete this enhanced security questionnaire.
Our applicable agreements set out several security and compliance measures that are essential for safe use of the 1inch infrastructure. These include, among others, the use of the origin parameter, market-standard screening tools, end-user and transaction screening commitments, law-enforcement cooperation obligations, and other requirements designed to protect the broader ecosystem.
The purpose of this questionnaire is to help us verify alignment with these measures. Depending on the results, 1inch may request certain remediation steps, which would need to be implemented; otherwise, service access may be suspended in accordance with our contract.
We are confident that you share our commitment to maintaining a secure and compliant environment, and we appreciate your cooperation in this process.

1.1 Customer Name (legal entity name or individual full name)
Rajasekar S P

1.2 Project Name (trade name used for negotiations with 1inch/ in the course of business/ easily identifiable by public).
Vaipakam

1.3 Customer/ Project website.
https://vaipakam.com/

1.4 When was your business established? For legal entity: include the company registration date; for individuals: include the date of the launch of your business/project.

14/04/2026

2. Business Activity

2.1 In which countries/markets/regions does your business predominantly operate?
It is a global platform operated from India

2.2 Who are your expected primary end-users?
Individual users

2.3 What is the expected monthly transaction volume (in USD equivalent)?
< USD 1,000,000

1. Risk Management & Operational Controls

3.1 Risk Management Framework

Vaipakam’s risk management framework is built around a non-custodial, on-chain peer-to-peer lending and NFT rental platform with layered controls across product, smart contracts, frontend safety, infrastructure, and operations.

Risk identification and assessment are handled through protocol design reviews, internal security review, functional specifications, release notes, test coverage, deployment runbooks, monitoring, and audit-preparation workflows. Key risk categories include smart contract risk, oracle risk, liquidation and market-liquidity risk, sanctions/compliance risk, frontend transaction-safety risk, operational key risk, data/privacy risk, and infrastructure risk.

Risk mitigation includes:

- Health Factor, LTV, collateral, liquidation, and default controls.
- Oracle freshness checks, secondary-oracle quorum checks, and sequencer-health checks.
- Slippage-protected liquidation and swap-adapter failover.
- Active-chain liquidity checks using slippage-at-floor route simulation.
- Bounded protocol configuration parameters with explicit validation.
- Role-based access control for administrative functions.
- Emergency pause controls for incident response.
- Permissionless liquidation/default execution so protocol-safety actions do not depend on privileged bots.
- Frontend transaction previews, risk disclosures, consent gates, and error reporting.
- Public analytics and on-chain event transparency.

Risk ownership is divided by function:

- Engineering/security maintainers own code review, testing, deployment verification, and incident triage.
- Operations signers own emergency response, pause controls, and production monitoring.
- Authorized protocol administrators own bounded protocol configuration and operational setup.
- Support/privacy operators handle diagnostic telemetry, support reports, retention controls, and data-rights requests.

Risk controls are reviewed during release cycles, deployment rehearsals, incident reviews, and security testing. Monitoring includes on-chain events, worker/indexer health checks, alerting for invalid state transitions, public analytics, protocol-health dashboards, and operator runbooks.

3.2 Regulatory or Licensing Requirements

Vaipakam is designed as a non-custodial, on-chain peer-to-peer protocol and frontend. The platform does not custody user assets, does not operate fiat rails, does not maintain user accounts, and does not act as a bank, broker, exchange, investment adviser, or money transmitter in its current design. Users interact directly with public smart contracts through their own self-custodied wallets.

Vaipakam does not currently claim to hold regulatory licenses or registrations. The current operating position is that the platform is non-custodial DeFi software with no custody, no fiat conversion, no managed accounts, and no off-chain identity account system. Users remain responsible for their own jurisdictional compliance, and the Terms prohibit use from jurisdictions where access is restricted or would require registration the user has not completed.

Legal review should be maintained before launch and before adding any service that could change this analysis, including custody, fiat services, managed accounts, brokered services, or off-chain user-account services.

3.3 AML, Sanctions, and Financial-Crime Prevention Programs

Vaipakam’s current design is non-custodial and does not collect KYC documents or maintain off-chain user accounts. The current compliance posture focuses on sanctions screening, prohibited-use terms, transaction transparency, risk disclosures, and retained technical hooks for compliance controls.

Current controls include:

- Terms of Service prohibiting sanctions violations, money laundering, terrorist financing, illegal activity, and use from prohibited jurisdictions.
- Address-level sanctions screening where a supported on-chain sanctions oracle is configured.
- Blocking of new value-creating or value-receiving actions for flagged wallets.
- Wind-down carve-outs that permit debt-closing or safety actions needed to protect unflagged counterparties.
- Public on-chain auditability of loans, offers, liquidations, claims, and protocol events.
- Advanced stuck-token recovery requiring a user declaration of token source, with sanctions checks on the declared source.

Vaipakam does not currently perform traditional customer due diligence because there are no accounts and no custody.

3.4 Screening and Security Tools Used in Connection with the API

Vaipakam uses or is designed to use the following screening and security controls:

- On-chain sanctions oracle: Chainalysis-style sanctions oracle integration where configured on the active chain.
- Blockaid transaction simulation: frontend review modals may call a server-side Blockaid proxy before final transaction submission. API keys remain server-side.
- Oracle quorum checks: Chainlink primary pricing with Tellor/API3/DIA secondary checks where configured.
- Sequencer uptime checks: L2 sequencer health checks before price-dependent liquidation/default paths.
- Slippage and liquidity simulation: liquidation and asset-liquidity checks use oracle-anchored slippage controls.
- Monitoring alerts: operational alerting for invalid state transitions and runtime anomalies.
- Cloudflare Worker protections: API keys are kept server-side; quote and worker routes can apply upstream rate limits.
- Wallet and action gating: sanctions banners, blocked-state UI, Terms acceptance gate, and transaction review modals.
- Permit2 scoped signatures: exact asset/amount/spender scope, 30-minute expiry, fallback to approve-plus-action.
- Public analytics and exportable event data: supports auditability without collecting PII.

  3.5 Procedures for Sanctioned Wallets, High-Risk Protocols, and Tainted Funds

Where sanctions screening is configured, Vaipakam screens relevant wallets before actions that create new positions, accept deposits, route new value, pay incentives, or allow claims by a flagged recipient. Flagged wallets are restricted from new value-creating or value-receiving actions, including offer creation/acceptance, VPFI buy/deposit/withdraw flows, liquidation initiation, recovery, and claims by the flagged recipient.

Debt-closing and safety paths may remain available where necessary to protect an unflagged counterparty. For example, repayment, time-based default, or liquidation against a flagged borrower may be permitted as wind-down/recovery paths, but the flagged actor must not receive fresh protocol value.

For tainted or unsolicited funds, Vaipakam uses a protocol-tracked balance model. Direct unsolicited token transfers to a user’s Vaipakam Vault are hidden from ordinary balance, staking, and discount views. The advanced stuck-token recovery flow requires the user to declare the source address through an EIP-712 signature. If the declared source is sanctioned, recovery is blocked and an event is emitted. Users may also “disown” unsolicited tokens through an event-only declaration for audit-trail purposes.

Escalation is event-driven: sanctions matches, blocked recoveries, invalid transitions, oracle failures, and abnormal events are surfaced through UI state, logs, monitoring, and operator review. Emergency response may include pausing affected assets or protocol functions.

3.6 Data Retention and Log Preservation Policy

Vaipakam is designed to minimize off-chain data collection.

Data retained:

- On-chain activity and indexed protocol data: wallet addresses, transactions, offers, loans, and protocol events are public on the blockchain. Vaipakam may index a derived copy of public on-chain offer, loan, activity, and claimability data in Cloudflare D1 or similar infrastructure to support app performance, public analytics, troubleshooting, and data-freshness monitoring. This indexed data is derived from public blockchain records and is not treated as a separate off-chain user account profile.
- Error and journey-log diagnostics: Vaipakam plans to collect limited troubleshooting telemetry from the frontend and supporting API/worker services. This includes timestamps, chain ID, route/screen or flow name, non-sensitive error codes/messages, request correlation IDs, transaction hash where relevant, and shortened or hashed wallet addresses where needed for debugging. Client-side redaction should remove private keys, seed phrases, access tokens, full request payloads, and other secrets before upload. These diagnostics are used only for troubleshooting, reliability, abuse/security investigation, and support.
- Analytics: Google Analytics only if the user consents through the cookie banner.
- Essential cookies/local storage: theme, language, chain selection, consent state, and similar app-functionality settings are retained until the user clears or revokes them.
- Operational logs: worker, indexer, monitoring, API, and security logs are used for debugging, uptime, incident response, and abuse/security investigation. These are access-restricted and retained only as needed for operational and legal purposes.
- Public blockchain records: immutable and retained by the underlying networks; Vaipakam cannot delete them.

Identifiable troubleshooting telemetry and operational logs are retained for at least 30 days to support fraud prevention, audit, security investigation, and lawful requests, and are then deleted or anonymized unless a specific security incident, abuse investigation, support ticket, or lawful preservation request requires a longer hold. Aggregated, non-identifying reliability metrics may be retained longer. Vaipakam provides data-rights functionality for browser-local data, including download and deletion of local journey logs and Vaipakam-namespaced local storage. Public on-chain data cannot be erased by frontend action.

3.7 You hereby confirm that you will retain relevant end-user data for a minimum of 30 days to support fraud prevention, audit, or lawful law enforcement requests, and that you will cooperate in good faith with 1inch in the event such data is needed for compliance or security investigations.
Yes

3.8 Please provide details of any past regulatory actions, inquiries, or fines related to AML, sanctions, or compliance matters (if any).
Not applicable.

3.9 Cooperation with Law Enforcement or Regulatory Bodies

Vaipakam will cooperate with law enforcement and regulatory bodies upon valid and lawful request. Because the platform is non-custodial and does not maintain user accounts or KYC documents, available information is limited.

Where legally required, Vaipakam may provide:

- Public on-chain transaction references.
- Contract addresses and deployment metadata.
- Public event data and analytics exports.
- Relevant operational/security logs and troubleshooting telemetry within the scope of the request and retention window.
- User-submitted support diagnostics, if available.
- Explanations of protocol mechanics and risk controls.

Vaipakam will seek to limit disclosure to the narrowest legally required scope and will not provide data it does not possess, such as private keys, custody access, deleted local browser data, or KYC documents not collected by the platform.

3.10 Suspicious Activity Identification, Escalation, and Reporting

Suspicious activity may be identified through:

- Sanctions oracle matches.
- Blocked stuck-token recovery attempts.
- Abnormal liquidation, oracle, or slippage events.
- Invalid state-transition alerts.
- Worker/indexer monitoring anomalies.
- User support reports, uploaded error telemetry, and issue diagnostics.
- Public on-chain event review.
- Security reports or bug bounty submissions.

Escalation follows severity:

- Routine UI or support issues are triaged by maintainers.
- Security-sensitive anomalies are escalated to engineering/security operators.
- Protocol-risk issues may trigger emergency pause review.
- Confirmed legal or sanctions issues are handled according to the Terms, sanctions-screening controls, and lawful-request process.

Where required by applicable law, Vaipakam will preserve relevant logs and cooperate with competent authorities. Public on-chain records also provide an immutable audit trail for suspicious-activity review.

3.11 Agreement to Provide Additional Documentation

Yes. Vaipakam agrees to provide additional reasonable documentation or evidence of its AML, sanctions, security, and risk-management programs upon request, subject to confidentiality, security, legal privilege, and protection of sensitive operational details.

4. Security:

4.1 Incident Response / Security-Incident Handling Procedures

Vaipakam maintains an incident-response process covering detection, escalation, communication, containment, remediation, and post-incident review.

Detection sources include smart-contract events, indexer and worker logs, invalid state-transition alerts, oracle/liquidity anomalies, frontend error telemetry, user support reports, security disclosures, and monitoring of critical infrastructure. High-severity events may include suspected contract exploit, oracle failure, sanctions-screening malfunction, compromised API key, frontend compromise, indexer corruption, abnormal liquidation behavior, or data exposure.

Escalation is severity-based:

- Routine frontend or support issues are triaged by engineering/support operators.
- Security-sensitive issues are escalated to engineering/security maintainers.
- Protocol-risk issues may trigger emergency pause review for affected assets or functions.
- API, key, or infrastructure compromise triggers credential rotation, endpoint lockdown, and access review.
- Legal, sanctions, or law-enforcement matters are escalated to the appropriate responsible operator or counsel.

Containment and remediation may include disabling affected API routes, rotating secrets, pausing affected protocol functions, removing or replacing compromised frontend builds, blocking malicious addresses where supported, reverting to known-good deployments, increasing monitoring, publishing user guidance, and preparing a post-incident report.

After resolution, Vaipakam performs a review covering root cause, user impact, affected systems, timeline, corrective actions, additional tests, monitoring gaps, and process improvements.

4.2 API Key and Credential Storage / Protection

Vaipakam uses environment-specific secret management and does not commit private keys, API keys, or production credentials to the repository. Example environment files are maintained separately from real `.env` files.

Credential controls include:

- Separate secrets for local development, testnet, and production.
- API keys stored in deployment/runtime secret systems such as Cloudflare Worker secrets, hosting-provider environment variables, or local-only operator environment files.
- Browser clients do not receive sensitive API keys. External quote/scanning providers such as 1inch, 0x, Blockaid, or RPC providers are accessed through server-side proxy routes where needed.
- Smart-contract admin and operational keys are separated by role.
- Keeper/liquidation bots use hot keys with no administrative smart-contract authority.
- Emergency/admin signer access is limited to authorized operators.
- Secrets are rotated after suspected exposure, staff/access changes, provider migration, or incident response.
- Deployment scripts include preflight checks for required secrets and fail if active-chain RPC/API secrets are missing.
- Logs and support reports should redact secrets, tokens, private keys, seed phrases, full payloads, and sensitive headers before storage.

  4.3 Have you experienced any cybersecurity breach, wallet compromise, or data loss event in the past 3 years?

No.

4.4 If yes, please summarize the incident(s) and corrective actions

Not applicable.

4.5 Cooperation with 1inch

Yes.

Vaipakam will cooperate in good faith with 1inch to mitigate or investigate potential abuse, fraud, exploit activity, suspicious transaction patterns, compromised integrations, API misuse, or security incidents involving the integration. Cooperation may include preserving relevant logs within the retention window, sharing transaction hashes and contract addresses, assisting with technical interpretation, disabling affected routes, rotating credentials, and implementing reasonable mitigation steps.

4.6 Baseline AML, Sanctions, and Security Controls

Yes.

Vaipakam commits to maintaining baseline AML, sanctions, and security controls required by 1inch and to progressively aligning with coalition-led playbooks and standards such as ZeroShadow, SEAL911, or equivalents as they evolve.

4.7 Technical Expertise

Yes.

Vaipakam confirms that it has sufficient technical expertise to correctly interpret and work with data returned by the API. If uncertain about API behavior, risk signals, transaction routing, or integration-specific interpretation, Vaipakam will proactively contact the technical support team. Vaipakam acknowledges that failure to seek support where needed is at its own risk and responsibility.

5. Miscellaneous

5.1 Compliance Contact

Name: Rajasekar S P;
Title: Founder / Operations Lead;
Email: compliance@vaipakam.com

5.2 Security Contact

Name: Rajasekar S P;
Title: Founder / Engineering Lead;
Email: security@vaipakam.com

5.3 Risk Management Contact

Name: Rajasekar S P;
Title: Founder / Protocol Operations Lead;
Email: risk@vaipakam.com

5.4 Individual Completing This Form

Name: Rajasekar S P;
Role: Founder / Authorized Representative;
Email: rajasekar.sp@vaipakam.com

5.5 Declaration

Yes.

Any Additional Information or Comments

Vaipakam is a non-custodial, on-chain peer-to-peer lending and NFT rental platform. The platform is designed to minimize off-chain user data collection, keep user assets under smart-contract and self-custody flows, and apply layered controls for transaction safety, sanctions screening where configured, oracle/liquidity risk, operational monitoring, and incident response.

Vaipakam is currently founder-operated. The same responsible individual currently oversees compliance, security, and risk-management matters. As the project grows, these responsibilities may be delegated to dedicated operators or external advisors. The provided emails are responsible for coordinating compliance, security, and risk-management responses, including cooperation with 1inch on integration safety, abuse investigation, credential rotation, and incident mitigation where applicable.
