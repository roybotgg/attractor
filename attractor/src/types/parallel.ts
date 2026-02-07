export const JoinPolicy = {
  WAIT_ALL: "wait_all",
  K_OF_N: "k_of_n",
  QUORUM: "quorum",
  FIRST_SUCCESS: "first_success",
} as const;
export type JoinPolicy = (typeof JoinPolicy)[keyof typeof JoinPolicy];

const JOIN_POLICY_VALUES = new Set<string>(Object.values(JoinPolicy));

export function parseJoinPolicy(value: string): JoinPolicy {
  if (JOIN_POLICY_VALUES.has(value)) {
    // Safe: we just verified the value is in the set
    return value as JoinPolicy;
  }
  return JoinPolicy.WAIT_ALL;
}

export const ErrorPolicy = {
  CONTINUE: "continue",
  FAIL_FAST: "fail_fast",
  IGNORE: "ignore",
} as const;
export type ErrorPolicy = (typeof ErrorPolicy)[keyof typeof ErrorPolicy];

const ERROR_POLICY_VALUES = new Set<string>(Object.values(ErrorPolicy));

export function parseErrorPolicy(value: string): ErrorPolicy {
  if (ERROR_POLICY_VALUES.has(value)) {
    // Safe: we just verified the value is in the set
    return value as ErrorPolicy;
  }
  return ErrorPolicy.CONTINUE;
}
