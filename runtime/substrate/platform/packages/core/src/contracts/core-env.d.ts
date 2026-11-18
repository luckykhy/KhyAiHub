export interface CoreEnvValues {
  endpoint?: string;
  token?: string;
  mode?: 'auto' | 'embedded' | 'attached';
}

export declare const CORE_ENV_KEYS: Readonly<{
  endpoint: 'KHY_CORE_ENDPOINT';
  token: 'KHY_CORE_TOKEN';
  mode: 'KHY_CORE_MODE';
}>;
export declare const CORE_MODE_VALUES: readonly ['auto', 'embedded', 'attached'];
export declare const DEFAULT_BIND_HOST: '127.0.0.1';
export declare function readCoreEnv(env?: Record<string, string | undefined>): CoreEnvValues;
