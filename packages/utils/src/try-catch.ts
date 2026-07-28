// SPDX-License-Identifier: Apache-2.0
// Result-style error handling: turn a throwing call into a { data, error }
// pair so the caller branches on `error` instead of nesting try/catch. Shared
// across apps/web and every @doota/* package (this is a leaf — no deps).
type Success<T> = { data: T; error: null };
type Failure<E> = { data: null; error: E };
export type Result<T, E = Error> = Success<T> | Failure<E>;

export const tryCatch = async <T, E = Error>(promise: Promise<T>): Promise<Result<T, E>> => {
	try {
		const data = await promise;
		return { data, error: null };
	} catch (error) {
		return { data: null, error: error as E };
	}
};

export const tryCatchSync = <T, E = Error>(func: () => T): Result<T, E> => {
	try {
		const data = func();
		return { data, error: null };
	} catch (error) {
		return { data: null, error: error as E };
	}
};
