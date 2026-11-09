import { describe, expect, it } from 'vitest';
import { downloadBody, eraseAll, isAppKey, itemCount, readCookie, REPORT_KEY, takeInventory, type EraseSteps, type Sources, type StorageLike } from './dataRights';

function store(entries: Record<string, string> = {}, opts: { sticky?: string[] } = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => {
      if (!opts.sticky?.includes(k)) map.delete(k);
    },
  };
}

const W = '0xabcdef0000000000000000000000000000000001';

function sources(over: Partial<Sources> = {}, local = store(), session = store()): Sources {
  return { local: () => local, session: () => session, databases: async () => [], cookie: () => '', ...over };
}

describe('what this browser keeps', () => {
  it('tells the app’s own records from the wallet libraries’', () => {
    expect(isAppKey('app.theme')).toBe(true);
    expect(isAppKey(`alpha05.alerts.v1:84532:${W}`)).toBe(true);
    expect(isAppKey('vaipakam:language')).toBe(true);
    expect(isAppKey('wagmi.store')).toBe(false);
    expect(isAppKey('wc@2:core:0.3//keychain')).toBe(false);
  });
  it('counts every item an erasure would remove, and lists the app’s records', async () => {
    const local = store({ 'app.theme': 'dark', [`alpha05.alerts.v1:84532:${W}`]: '{"dueDate":{"on":false,"at":1}}', 'wagmi.store': '{}', 'wc@2:x': 'y' });
    const session = store({ 'app.chunkReloaded': '1', [REPORT_KEY]: '{}' });
    const inv = await takeInventory(sources({ databases: async () => ['WALLET_CONNECT_V2_INDEXED_DB'], cookie: () => 'a=1; vaipakam_lang=es' }, local, session));
    expect(inv.app.map((r) => r.key)).toEqual([`alpha05.alerts.v1:84532:${W}`, 'app.theme']);
    expect(inv.connector).toBe(2);
    expect(inv.session).toBe(1);
    expect(inv.langCookie).toBe(true);
    expect(itemCount(inv)).toBe(2 + 2 + 1 + 1 + 1);
  });
  it('says so when storage cannot be read or databases cannot be listed', async () => {
    const inv = await takeInventory(
      sources({
        local: () => {
          throw new Error('blocked');
        },
        databases: async () => 'unknown',
      }),
    );
    expect(inv.unreadable).toEqual(['local']);
    expect(inv.databases).toBe('unknown');
  });
  it('downloads the app’s records with the wallet addresses named, and counts what it leaves out', async () => {
    const local = store({ 'app.mode': 'advanced', 'wc@2:core:keychain': 'secret-session-material' });
    const inv = await takeInventory(sources({}, local));
    const body = JSON.parse(downloadBody(inv, new Date('2026-11-09T00:00:00Z'), [W]));
    expect(body.records).toEqual({ 'app.mode': 'advanced' });
    expect(body.walletAddresses).toEqual([W]);
    expect(body.notIncluded.walletConnectionItems).toBe(1);
    expect(JSON.stringify(body)).not.toContain('secret-session-material');
  });
  it('reads one cookie by name', () => {
    expect(readCookie('vaipakam_lang', 'x=1; vaipakam_lang=zh; y=2')).toBe('zh');
    expect(readCookie('vaipakam_lang', 'x=1')).toBeNull();
  });
});

describe('erasing', () => {
  function steps(over: Partial<EraseSteps> = {}, local = store(), session = store()): EraseSteps {
    let cookie = 'vaipakam_lang=es';
    return {
      ...sources({ databases: async () => ['A', 'B'], cookie: () => cookie }, local, session),
      disconnect: async () => true,
      deleteDatabase: async () => undefined,
      clearCookie: () => {
        cookie = '';
      },
      ...over,
    };
  }
  it('disconnects first, then removes everything, keeping only this tab’s report', async () => {
    const order: string[] = [];
    const local = store({ 'app.theme': 'dark', 'wagmi.store': '{}' });
    const session = store({ 'app.chunkReloaded': '1', [REPORT_KEY]: 'old' });
    const report = await eraseAll(
      steps(
        {
          disconnect: async () => {
            order.push(`disconnect with ${local.length} items`);
            return true;
          },
        },
        local,
        session,
      ),
      1_000,
    );
    expect(order).toEqual(['disconnect with 2 items']);
    expect(report).toEqual({
      at: 1_000,
      disconnected: true,
      removed: { app: 1, connector: 1, session: 1, databases: 2, langCookie: true },
      refused: [],
      databasesUnknown: false,
    });
    expect(local.length).toBe(0);
    expect([...session.map.keys()]).toEqual([REPORT_KEY]);
  });
  it('reports each refusal with its reason and still runs the next step', async () => {
    const local = store({ 'app.theme': 'dark', 'wagmi.store': '{}' }, { sticky: ['wagmi.store'] });
    const report = await eraseAll(
      steps(
        {
          disconnect: async () => false,
          deleteDatabase: async (name) => {
            if (name === 'B') throw new Error('another tab of this site holds it open');
          },
          clearCookie: () => undefined,
        },
        local,
      ),
    );
    expect(report.disconnected).toBe(false);
    expect(report.removed.databases).toBe(1);
    expect(report.removed.langCookie).toBe(false);
    expect(report.refused).toEqual([
      { what: 'local', reason: '1 item(s) were written back or would not go' },
      { what: 'database', name: 'B', reason: 'another tab of this site holds it open' },
      { what: 'cookie', name: 'vaipakam_lang', reason: 'the browser kept it' },
    ]);
  });
  it('claims no disconnection when no wallet was connected, and says databases were not listed when they cannot be', async () => {
    const report = await eraseAll(steps({ disconnect: async () => null, databases: async () => 'unknown' }));
    expect(report.disconnected).toBeNull();
    expect(report.databasesUnknown).toBe(true);
  });
});
