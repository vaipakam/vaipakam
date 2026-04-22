/**
 * Mutable in-memory state shared between the mocked `ethers` module and the
 * test that owns it. Tests push values in via `resetEthersState` / direct
 * assignment, then the Contract / Provider / Signer mocks below read them.
 */
export interface EthersState {
  contractMethods: Record<string, (...args: any[]) => any>;
  signerAddress: string | null;
  chainId: number;
  requestAccountsResult: string[];
  sendImpl: ((method: string, params?: any) => any) | null;
}

export const ethersState: EthersState = {
  contractMethods: {},
  signerAddress: null,
  chainId: 11155111,
  requestAccountsResult: [],
  sendImpl: null,
};

export function resetEthersState() {
  ethersState.contractMethods = {};
  ethersState.signerAddress = null;
  ethersState.chainId = 11155111;
  ethersState.requestAccountsResult = [];
  ethersState.sendImpl = null;
}

export function setContractMethod(name: string, fn: (...args: any[]) => any) {
  ethersState.contractMethods[name] = fn;
}

/**
 * Factory returning the mocked `ethers` module. Pass to `vi.mock('ethers', ...)`
 * at the top level of a test file. Each mock pulls its dynamic values from
 * `ethersState`, so tests stay deterministic across runs.
 */
export const ethersMockModule = () => {
  const parseUnits = (v: string, _decimals?: number) => BigInt(Math.floor(parseFloat(v) * 1e18));
  const formatUnits = (value: bigint, decimals: number = 18) => {
    const neg = value < 0n;
    let abs = neg ? -value : value;
    const base = 10n ** BigInt(decimals);
    const whole = abs / base;
    const frac = abs % base;
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    const s = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
    return neg ? `-${s}` : s;
  };

  class ContractMock {
    target: string;
    constructor(target: string, _abi: any, _runner: any) {
      this.target = target;
      return new Proxy(this, {
        get(obj, prop) {
          if (prop in obj) return (obj as any)[prop];
          const fn = ethersState.contractMethods[String(prop)];
          if (fn) return (...args: any[]) => Promise.resolve(fn(...args));
          return (..._args: any[]) => Promise.resolve(undefined);
        },
      });
    }
  }

  class JsonRpcProviderMock {
    constructor(public url: string) {}
    async getNetwork() { return { chainId: BigInt(ethersState.chainId) }; }
    async getBlockNumber() { return 1; }
  }

  class JsonRpcSignerMock {
    async getAddress() { return ethersState.signerAddress ?? '0x0000000000000000000000000000000000000000'; }
  }

  class BrowserProviderMock {
    constructor(public eth: any) {}
    async send(method: string, params: any) {
      if (ethersState.sendImpl) return ethersState.sendImpl(method, params);
      if (method === 'eth_requestAccounts') return ethersState.requestAccountsResult;
      return undefined;
    }
    async getSigner() { return new JsonRpcSignerMock(); }
    async getNetwork() { return { chainId: BigInt(ethersState.chainId) }; }
  }

  // Lightweight stand-ins for utilities the non-test code pulls in at
  // module load (e.g. logIndex.ts computing topic hashes via `id`). Tests
  // don't exercise event filtering end-to-end, so the returned value just
  // needs to be a stable string keyed by input.
  const id = (signature: string) =>
    '0x' + signature.split('').reduce((h, c) => ((h * 31 + c.charCodeAt(0)) >>> 0).toString(16), 0)
      .toString()
      .padStart(64, '0');

  class AbiCoderMock {
    static defaultAbiCoder() { return new AbiCoderMock(); }
    encode(_types: readonly string[], _values: readonly unknown[]) { return '0x'; }
    decode(_types: readonly string[], _data: string): unknown[] { return []; }
  }

  class InterfaceMock {
    constructor(_abi: unknown) {}
    encodeFunctionData(_fn: string, _args: readonly unknown[]) { return '0x'; }
    decodeFunctionResult(_fn: string, _data: string): unknown[] { return []; }
    getFunction(_name: string) { return { name: _name }; }
  }

  return {
    Contract: ContractMock,
    JsonRpcProvider: JsonRpcProviderMock,
    JsonRpcSigner: JsonRpcSignerMock,
    BrowserProvider: BrowserProviderMock,
    Interface: InterfaceMock,
    AbiCoder: AbiCoderMock,
    parseUnits,
    formatUnits,
    id,
    isAddress: (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v),
    MaxUint256: (1n << 256n) - 1n,
  };
};

