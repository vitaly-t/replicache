import type {JSONValue} from './json.js';
import {
  Invoke,
  OpenTransactionRequest,
  CommitTransactionResponse,
  RPC,
} from './repm-invoker.js';
import type {KeyTypeForScanOptions, ScanOptions} from './scan-options.js';
import {ScanResult} from './scan-iterator.js';
import {throwIfClosed} from './transaction-closed-error.js';

/**
 * ReadTransactions are used with [[Replicache.query]] and
 * [[Replicache.subscribe]] and allows read operations on the
 * database.
 */
export interface ReadTransaction {
  /**
   * Get a single value from the database. If the `key` is not present this
   * returns `undefined`.
   */
  get(key: string): Promise<JSONValue | undefined>;

  /** Determines if a single `key` is present in the database. */
  has(key: string): Promise<boolean>;

  /** Whether the database is empty. */
  isEmpty(): Promise<boolean>;

  /**
   * Gets many values from the database. This returns a [[ScanResult]] which
   * implements `AsyncIterable`. It also has methods to iterate over the [[ScanResult.keys|keys]]
   * and [[ScanResult.entries|entries]].
   *
   * If `options` has an `indexName`, then this does a scan over an index with
   * that name. A scan over an index uses a tuple for the key consisting of
   * `[secondary: string, primary: string]`.
   *
   * If the [[ScanResult]] is used after the `ReadTransaction` has been closed it
   * will throw a [[TransactionClosedError]].
   */
  scan<O extends ScanOptions, K extends KeyTypeForScanOptions<O>>(
    options?: O,
  ): ScanResult<K>;

  /**
   * Convenience form of [[scan]] which returns all the entries as an array.
   */
  scanAll<O extends ScanOptions, K extends KeyTypeForScanOptions<O>>(
    options?: O,
  ): Promise<[K, JSONValue][]>;
}

export class ReadTransactionImpl implements ReadTransaction {
  private _transactionId = -1;
  protected readonly _invoke: Invoke;
  protected _closed = false;
  protected readonly _openTransactionName:
    | RPC.OpenTransaction
    | RPC.OpenIndexTransaction = RPC.OpenTransaction;

  constructor(invoke: Invoke) {
    this._invoke = invoke;
  }

  async get(key: string): Promise<JSONValue | undefined> {
    throwIfClosed(this);
    const result = await this._invoke(RPC.Get, {
      transactionId: this._transactionId,
      key,
    });
    if (!result.has) {
      return undefined;
    }
    return JSON.parse(result.value);
  }

  async has(key: string): Promise<boolean> {
    throwIfClosed(this);
    const result = await this._invoke(RPC.Has, {
      transactionId: this._transactionId,
      key,
    });
    return result['has'];
  }

  async isEmpty(): Promise<boolean> {
    throwIfClosed(this);

    let empty = true;
    await this._invoke(RPC.Scan, {
      transactionId: this._transactionId,
      opts: {limit: 1},
      receiver: () => (empty = false),
    });
    return empty;
  }

  scan<O extends ScanOptions, K extends KeyTypeForScanOptions<O>>(
    options?: O,
  ): ScanResult<K> {
    return new ScanResult(options, this._invoke, () => this, false);
  }

  async scanAll<O extends ScanOptions, K extends KeyTypeForScanOptions<O>>(
    options?: O,
  ): Promise<[K, JSONValue][]> {
    type E = [K, JSONValue];
    const it = this.scan(options).entries();
    const result: E[] = [];
    for await (const pair of it) {
      result.push(pair as E);
    }
    return result;
  }

  get id(): number {
    return this._transactionId;
  }

  get closed(): boolean {
    return this._closed;
  }

  async open(args: OpenTransactionRequest): Promise<void> {
    const {transactionId} = await this._invoke(this._openTransactionName, args);
    this._transactionId = transactionId;
  }

  async close(): Promise<void> {
    try {
      this._closed = true;
      await this._invoke(RPC.CloseTransaction, {
        transactionId: this._transactionId,
      });
    } catch (ex) {
      console.error('Failed to close transaction', ex);
    }
  }
}

/**
 * WriteTransactions are used with
 * [[Replicache.register]] and allows read and write
 * operations on the database.
 */
export interface WriteTransaction extends ReadTransaction {
  /**
   * Sets a single `value` in the database. The `value` will be encoded using
   * `JSON.stringify`.
   */
  put(key: string, value: JSONValue): Promise<void>;

  /**
   * Removes a `key` and its value from the database. Returns `true` if there was a
   * `key` to remove.
   */
  del(key: string): Promise<boolean>;
}

export class WriteTransactionImpl
  extends ReadTransactionImpl
  implements WriteTransaction {
  async put(key: string, value: JSONValue): Promise<void> {
    throwIfClosed(this);
    await this._invoke(RPC.Put, {
      transactionId: this.id,
      key,
      value: JSON.stringify(value),
    });
  }

  async del(key: string): Promise<boolean> {
    throwIfClosed(this);
    const result = await this._invoke(RPC.Del, {
      transactionId: this.id,
      key,
    });
    return result.ok;
  }

  async commit(): Promise<CommitTransactionResponse> {
    this._closed = true;
    return await this._invoke(RPC.CommitTransaction, {
      transactionId: this.id,
    });
  }
}

export interface IndexTransaction extends ReadTransaction {
  /**
   * Creates a persistent secondary index in Replicache which can be used with
   * scan.
   *
   * If the named index already exists with the same definition this returns
   * success immediately. If the named index already exists, but with a
   * different definition an error is thrown.
   */
  createIndex(def: CreateIndexDefinition): Promise<void>;

  /**
   * Drops an index previously created with [[createIndex]].
   */
  dropIndex(name: string): Promise<void>;
}

/**
 * The definition of an index. This is used with
 * [[Replicache.createIndex|createIndex]] when creating indexes.
 */
export interface CreateIndexDefinition {
  /** The name of the index. This is used when you [[ReadTransaction.scan|scan]] over an index. */
  name: string;

  /**
   * The prefix, if any, to limit the index over. If not provided the values of
   * all keys are indexed.
   */
  keyPrefix?: string;

  /**
   * A [JSON Pointer](https://tools.ietf.org/html/rfc6901) pointing at the sub
   * value inside each value to index over.
   *
   * For example, one might index over users' ages like so:
   * `createIndex({name: 'usersByAge', keyPrefix: '/user/', jsonPointer: '/age'})`
   */
  jsonPointer: string;
}

export class IndexTransactionImpl
  extends ReadTransactionImpl
  implements IndexTransaction {
  protected readonly _openTransactionName = RPC.OpenIndexTransaction;

  async createIndex(options: CreateIndexDefinition): Promise<void> {
    throwIfClosed(this);
    await this._invoke(RPC.CreateIndex, {
      transactionId: this.id,
      name: options.name,
      keyPrefix: options.keyPrefix || '',
      jsonPointer: options.jsonPointer,
    });
  }

  async dropIndex(name: string): Promise<void> {
    throwIfClosed(this);
    await this._invoke(RPC.DropIndex, {
      transactionId: this.id,
      name,
    });
  }

  async commit(): Promise<CommitTransactionResponse> {
    this._closed = true;
    return await this._invoke(RPC.CommitTransaction, {
      transactionId: this.id,
    });
  }
}
