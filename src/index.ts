import { Contract, WalletConnection, utils } from "near-api-js";
import { jws, JwsOptions } from "./jws";

export { jws, JwsOptions };

const ONE = utils.format.parseNearAmount("1") ?? undefined;
export const CONTRACT_NAME = "lock-box";
const REMOTE_URL = "https://broker.staging.textile.io/";

export interface OpenOptions {
  region?: string;
}

export enum RequestStatus {
  Unknown = 0,
  Batching,
  Preparing,
  Auctioning,
  DealMaking,
  Success,
}

export type StatusFunction = (id: string) => Promise<StoreResponse>;

/**
 * Function definition for call to store data.
 */
export type StoreFunction = (
  data: File,
  options?: OpenOptions
) => Promise<StoreResponse>;

/**
 * Response from calls to the storage upload endpoint.
 */
export interface StoreResponse {
  id: string;
  cid: {
    "/": string;
  };
  status_code: RequestStatus;
}

export interface Storage {
  store: StoreFunction;
  status: StatusFunction;
}

export function openStore(
  connection: WalletConnection,
  options: { remoteUrl: string } = { remoteUrl: REMOTE_URL }
): Storage {
  const account = connection.account();
  const { accountId } = account;
  const { signer, networkId } = account.connection;
  const { remoteUrl } = options;
  return {
    store: async function store(
      data: File,
      options: OpenOptions = {}
    ): Promise<StoreResponse> {
      const formData = new FormData();
      for (const [key, value] of Object.entries(options)) {
        formData.append(key, value);
      }
      formData.append("file", data, data.name);
      const token = await jws(signer, {
        accountId,
        networkId,
        aud: remoteUrl,
      });
      const res = await fetch(`${remoteUrl}upload`, {
        method: "POST",
        body: formData,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const json = await res.json();
      return json;
    },
    status: async function status(id: string): Promise<StoreResponse> {
      const token = await jws(signer, {
        accountId,
        networkId,
        aud: REMOTE_URL,
      });
      const res = await fetch(`${remoteUrl}storagerequest/${id}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const json = await res.json();
      return json;
    },
  };
}

export interface DepositInfo {
  // The sender account id. i.e., the account locking the funds.
  sender: string;
  // The block index at which funds should expire.
  expiration: number;
  // The amount of locked funds (in Ⓝ). Currently defaults to 1.
  amount: number;
}

export interface LockInfo {
  accountId: string;
  brokerId: string;
  deposit: DepositInfo;
}

export interface BrokerInfo {
  brokerId: string;
  addresses: string[];
}

interface LockBoxContract extends Contract {
  lockFunds: (
    args: { brokerId: string; accountId?: string },
    gas?: string,
    amount?: string
  ) => Promise<LockInfo>;
  unlockFunds: (gas?: string, amount?: string) => Promise<void>;
  hasLocked: (args: {
    brokerId: string;
    accountId: string;
  }) => Promise<boolean>;
  getBroker: (brokerId?: string) => Promise<BrokerInfo | undefined>;
  listBrokers: () => Promise<BrokerInfo[]>;
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function openLockBox(connection: WalletConnection) {
  const account = connection.account();
  const { accountId } = account;
  const { networkId } = account.connection;
  const contractName = `${CONTRACT_NAME}.${networkId}`;
  const contract = new Contract(account, contractName, {
    // View methods are read-only – they don't modify the state, but usually return some value
    viewMethods: ["hasLocked"],
    // Change methods can modify the state, but you don't receive the returned value when called
    changeMethods: ["lockFunds", "unlockFunds"],
  }) as LockBoxContract;
  // Keep local cache
  let locked: boolean | null = null;
  const checkLocked = async (brokerId: string) => {
    if (!accountId)
      throw new Error("invalid accountId, ensure account is logged in");
    if (locked == null) {
      locked = await contract.hasLocked({ brokerId, accountId });
    }
    return locked;
  };
  const res = {
    listBrokers: async (): Promise<BrokerInfo[]> => {
      return contract.listBrokers();
    },
    getBroker: async (brokerId?: string): Promise<BrokerInfo | undefined> => {
      if (brokerId !== undefined) {
        return contract.getBroker(brokerId);
      }
      const brokers = await contract.listBrokers();
      const idx = Math.floor(Math.random() * brokers.length);
      return brokers[idx];
    },
    lockFunds: async (brokerId: string): Promise<LockInfo | undefined> => {
      if (!(await checkLocked(brokerId))) {
        return contract.lockFunds({ brokerId, accountId }, undefined, ONE);
      }
      locked = true;
      return;
    },
    unlockFunds: async (): Promise<void> => {
      return contract.unlockFunds();
    },
    hasLocked: (brokerId: string): Promise<boolean> => {
      // Reset locked variable
      locked = null;
      return checkLocked(brokerId);
    },
    requestSignIn: (
      title?: string | undefined,
      successUrl?: string | undefined,
      failureUrl?: string | undefined
    ): Promise<void> =>
      connection.requestSignIn(contractName, title, successUrl, failureUrl),
    signOut: () => connection.signOut(),
  };
  return res;
}

export type LockBox = ReturnType<typeof openLockBox>;
