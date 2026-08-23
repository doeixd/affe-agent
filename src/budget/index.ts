/**
 * Budget enforcement: a token ceiling a session carries at run time, enforced
 * through the loop seam. A `Budget` service holds the cumulative spend and a
 * `tokens` loop stops the run once the ceiling is reached. A battery over the
 * existing seams; it adds no capability to the engine. See `Budget`.
 */
export * as Budget from "./Budget.js"
