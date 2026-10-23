## Thread — The NFT verifier gives visitors something a copy cannot fake (PR #2698)

Position NFTs carry real claim rights, so a buyer might check one on the NFT verifier before paying for it. A copied verifier could show any verdict it liked. It could also add a "connect your wallet to confirm" step that drains the visitor's wallet. Nothing stops a web page from being copied, so the real verifier now tells visitors what they can check for themselves, without trusting whichever page they are on.

The verifier page now says, permanently, that checking a token never needs a wallet, a signature or an approval. It also says that any "verifier" asking for one of those is not Vaipakam's. The page shows the full contract address it checked against, linked to the network's block explorer, and explains that this address is what makes a token a Vaipakam position, while a token's name and picture can be copied by anyone. Every verdict, whether "live" or "does not exist", now links to the same token on the block explorer as an independent cross-check.

The Help page lists the Vaipakam contract address for every supported network. It also has a new answer on how to spot a fake verifier or a fake position NFT. The verifier's search listing no longer calls it a "rental" verifier, and the Help answer about the verifier no longer claims it shows loan terms, which it does not.

These changes cover the in-app half of the issue. The operational half stays open: watching for clone domains, reporting them to wallet blocklists, marketplace collection verification, and content-addressed hosting. Part of #745.
