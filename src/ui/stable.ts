import { useCallback, useRef } from "react";

// A function that keeps one identity while always calling the latest callback given, so a
// fresh closure from the parent does not re-render every memoized child.
export function useStableCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(callback);
  latest.current = callback;
  return useCallback((...args: Args) => latest.current(...args), []);
}
