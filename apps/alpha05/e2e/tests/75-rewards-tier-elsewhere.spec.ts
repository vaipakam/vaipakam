/**
 * Rewards, the wallet's fee-discount tier on the protocol's other networks
 * (matrix RW-11, RW-13, RW-14, #3579), from the protocol's own status
 * (`getTierPushStatus`, #1277). The protocol pays for a message only when
 * it lowers what another network grants; a higher tier goes only with a
 * paid send (`deliverTierPush`). On VPFI's home network the page states the
 * tier recorded for sending, says when it is behind the tier now and
 * offers the update (`pokeMyTier`), lists each other network with what it
 * last received and who sends what it is owed, and offers the paid send
 * with the fees quoted now, measuring what was paid and what came back.
 * Away from the home network it says a higher tier is sent from there.
 *
 * The fixture chain has no other network, so the reward messenger is a
 * stand-in placed with `anvil_setCode`: two destinations (Arbitrum Sepolia
 * and BNB Testnet), a fixed fee of 0.001 per message, and a send that takes
 * exactly that fee. Its source:
 *
 *     contract TierMessengerStub {
 *         uint256 constant FEE = 0.001 ether;
 *         function getBroadcastDestinations() external pure returns (uint256[] memory d) {
 *             d = new uint256[](2); d[0] = 421614; d[1] = 97;
 *         }
 *         function quoteSendTierUpdateTo(uint256, address, uint8, uint16, uint40, uint256, uint40, uint16)
 *             external pure returns (uint256) { return FEE; }
 *         function sendTierUpdateTo(uint256, address, uint8, uint16, uint40, uint256, uint40, uint16, address payable)
 *             external payable returns (bytes32) { require(msg.value == FEE); return bytes32(uint256(1)); }
 *     }
 *
 * (solc 0.8.29, optimizer on, EVM prague.) Runs on the desktop and the
 * phone project; the chain is reverted after each test.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import type { Page } from '@playwright/test';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import { anvilRpc, increaseTime, mine } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

const MESSENGER = '0x000000000000000000000000000000000000c0de' as Hex;
const MESSENGER_CODE =
  '0x608060405260043610610033575f3560e01c806356c0179f146100375780635780fa5d1461005d578063f7adeea21461007e575b5f5ffd5b61004a610045366004610186565b6100ac565b6040519081526020015b60405180910390f35b348015610068575f5ffd5b506100716100cf565b6040516100549190610220565b348015610089575f5ffd5b5061004a610098366004610262565b66038d7ea4c6800098975050505050505050565b5f66038d7ea4c6800034146100bf575f5ffd5b5060019998505050505050505050565b604080516002808252606080830184529260208301908036833701905050905062066eee815f81518110610105576101056102e8565b602002602001018181525050606181600181518110610126576101266102e8565b60200260200101818152505090565b6001600160a01b0381168114610149575f5ffd5b50565b803560ff8116811461015c575f5ffd5b919050565b803561ffff8116811461015c575f5ffd5b803564ffffffffff8116811461015c575f5ffd5b5f5f5f5f5f5f5f5f5f6101208a8c03121561019f575f5ffd5b8935985060208a01356101b181610135565b97506101bf60408b0161014c565b96506101cd60608b01610161565b95506101db60808b01610172565b945060a08a013593506101f060c08b01610172565b92506101fe60e08b01610161565b91506101008a013561020f81610135565b809150509295985092959850929598565b602080825282518282018190525f918401906040840190835b81811015610257578351835260209384019390920191600101610239565b509095945050505050565b5f5f5f5f5f5f5f5f610100898b03121561027a575f5ffd5b88359750602089013561028c81610135565b965061029a60408a0161014c565b95506102a860608a01610161565b94506102b660808a01610172565b935060a089013592506102cb60c08a01610172565b91506102d960e08a01610161565b90509295985092959890939650565b634e487b7160e01b5f52603260045260245ffdfea264697066735822122086837ebede4d47b57b403f1985d01e13db465ee947ed30d0ca7602a33540489264736f6c634300081d0033' as Hex;

type Lane = { destChainId: bigint; delivered: { nonce: bigint; tier: number }; owed: boolean; budgetPays: boolean };
type Status = readonly [bigint, number, number, number, number, readonly Lane[]];

async function fitsWidth(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('a higher tier reaches the other networks only with a paid send, after the record is updated; a lower one is the protocol’s to send', async ({
  launchWallet,
}) => {
  test.setTimeout(300_000);
  const sc = scenario();
  const lender = sc.address('lender');
  const token = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).illiquidToken!;
  await sc.diamondWrite('admin', 'setVPFIToken', [token]);
  await sc.diamondWrite('admin', 'setCanonicalVPFIChain', [true]);
  await anvilRpc('anvil_setCode', [MESSENGER, MESSENGER_CODE]);
  await sc.diamondWrite('admin', 'setRewardMessenger', [MESSENGER]);
  await sc.diamondWrite('lender', 'setVPFIDiscountConsent', [true]);

  // 200 VPFI held for four days: tier 1 applies now, but nothing has been
  // recorded for sending (the deposit came before the holding counted).
  await sc.write('lender', token, TOKEN_ABI, 'mint', [lender, parseEther('200')]);
  await sc.write('lender', token, erc20Abi, 'approve', [sc.diamond, parseEther('200')]);
  await sc.diamondWrite('lender', 'depositVPFIToVault', [parseEther('200')]);
  await increaseTime(4 * 86_400);
  await mine();
  expect(await sc.read<readonly [number, number]>('getEffectiveDiscount', [lender])).toEqual([1, 1000]);
  expect((await sc.read<Status>('getTierPushStatus', [lender]))[0]).toBe(0n);

  const { page } = await launchWallet('lender', { advanced: true });
  await page.goto('/rewards');
  await connectWallet(page);
  const s = page.getByTestId('rewards-elsewhere');
  await expect(s).toHaveAttribute('data-elsewhere', 'shown', { timeout: 60_000 });
  const record = page.getByTestId('rewards-elsewhere-record');
  await expect(record).toHaveAttribute('data-record', 'behind', { timeout: 60_000 });
  await expect(record).toContainText('No tier has been recorded for sending yet.');
  await expect(page.getByTestId('rewards-elsewhere-behind')).toHaveText(
    'Your tier now is tier 1, 10% off, but the record for sending holds something else. Update the record to send your tier now.',
  );
  const lanes = page.getByTestId('rewards-elsewhere-lane');
  await expect(lanes).toHaveCount(2);
  await expect(lanes.nth(0)).toContainText('Arbitrum Sepolia');
  await expect(lanes.nth(1)).toContainText('BNB Testnet');
  await expect(lanes.nth(0)).toContainText('Nothing has been sent to this network yet.');
  await expect(page.getByTestId('rewards-elsewhere-send')).toHaveCount(0);
  await expect(page.getByTestId('rewards-vpfi-elsewhere')).toBeVisible();
  await fitsWidth(page);

  // Update the record: gas only, and the protocol does not pay for a raise.
  await page.getByTestId('rewards-elsewhere-update').click();
  let receipt = s.locator('.receipt');
  await expect(receipt).toContainText('Update your tier record');
  await expect(receipt).toContainText('now tier 1, 10% off');
  await expect(receipt).toContainText('Network gas only. No VPFI moves.');
  await s.getByRole('button', { name: 'Confirm in wallet' }).click();
  let finish = s.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
  await expect(finish).toContainText('Record matches your tier now');
  await finish.getByRole('button', { name: 'Close' }).click();
  const recorded = await sc.read<Status>('getTierPushStatus', [lender]);
  expect([recorded[0], recorded[1], recorded[2]]).toEqual([1n, 1, 1000]);
  expect(recorded[5].map((l) => [l.owed, l.budgetPays])).toEqual([
    [true, false],
    [true, false],
  ]);

  await expect(record).toHaveAttribute('data-record', 'same', { timeout: 60_000 });
  await expect(record).toContainText('Recorded for sending: tier 1, 10% off your fees.');
  await expect(lanes.nth(0)).toHaveAttribute('data-standing', 'needs-paid-send');
  await expect(lanes.nth(0)).toContainText('Owed tier 1: it goes only with a paid send.');
  await expect(lanes.nth(0)).toContainText('Fee quoted now: 0.001 ETH.');
  await expect(s).toContainText('About 0.002 ETH in fees; unused value comes back.');

  // The paid send: the quoted fees plus the margin, the rest returned.
  const before = await sc.pub.getBalance({ address: lender });
  await page.getByTestId('rewards-elsewhere-send').click();
  receipt = s.locator('.receipt');
  await expect(receipt).toContainText('Send your tier to other networks');
  await expect(receipt).toContainText('Tier 1, 10% off your fees, recorded for sending');
  await expect(receipt).toContainText('Arbitrum Sepolia, BNB Testnet');
  await expect(receipt).toContainText('0.0024 ETH at most');
  await expect(receipt).toContainText('Each fee pays one message and is not refunded once sent');
  await fitsWidth(page);
  await s.getByRole('button', { name: 'Confirm in wallet' }).click();
  finish = s.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
  await expect(finish).toContainText('Sent to Arbitrum Sepolia');
  await expect(finish).toContainText('Sent to BNB Testnet');
  await expect(finish).toContainText('Paid 0.002 ETH in fees; 0.0004 ETH came back');
  await finish.getByRole('button', { name: 'Close' }).click();
  const spent = before - (await sc.pub.getBalance({ address: lender }));
  expect(spent).toBeGreaterThan(parseEther('0.002'));
  expect(spent).toBeLessThan(parseEther('0.0024'));
  expect(await sc.pub.getBalance({ address: MESSENGER })).toBe(parseEther('0.002'));
  await expect(lanes.nth(0)).toHaveAttribute('data-standing', 'current', { timeout: 60_000 });
  await expect(lanes.nth(1)).toContainText(/Holds tier 1, 10% off, sent .*UTC/);
  await expect(page.getByTestId('rewards-elsewhere-send')).toHaveCount(0);

  // Withdrawing every VPFI records tier 0: a lower tier, which the protocol
  // sends at its own cost (its budget is empty here, so it stays owed).
  await sc.diamondWrite('lender', 'withdrawVPFIFromVault', [parseEther('200')]);
  await expect(lanes.nth(0)).toHaveAttribute('data-standing', 'protocol-pays', { timeout: 60_000 });
  await expect(lanes.nth(0)).toContainText('Owed a lower tier: the protocol sends it at its own cost when its budget allows.');
  await expect(record).toContainText('Recorded for sending: tier 0, 0% off your fees.');

  // Away from VPFI's home network: a higher tier is sent from there.
  await sc.diamondWrite('admin', 'setCanonicalVPFIChain', [false]);
  const away = await launchWallet('lender');
  await away.page.goto('/rewards');
  await connectWallet(away.page);
  await expect(away.page.getByTestId('rewards-elsewhere')).toHaveAttribute('data-elsewhere', 'away', { timeout: 60_000 });
  await expect(away.page.getByTestId('rewards-elsewhere')).toContainText('A higher tier is sent from there.');
  await fitsWidth(away.page);
});
