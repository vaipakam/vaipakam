@echo off
echo ===================================================
echo GabinoTech OS - Submit Bounty PR for Issue #31
echo Destination Payout: gabinotech22@gmail.com
echo ===================================================
git push origin fix/bounty-issue-3364
gh pr create --title "Mainnet readiness: public bug bounty programme" --body-file PR_CLAIM_BUNDLE.md
echo [OK] Pull Request submitted. Check https://github.com/vaipakam/vaipakam/issues/3364
pause
