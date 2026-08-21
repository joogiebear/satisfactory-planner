/**
 * Dense dual simplex for problems of the form
 *
 *     minimise  c . x     subject to   A x >= b ,  x >= 0
 *
 * with `b >= 0` and `c >= 0`, which is exactly the shape a production plan
 * takes: costs (raw resources, buildings) are never negative and demands are
 * never negative.
 *
 * The planner needs a real LP rather than a recursive walk because Satisfactory
 * recipes form a general flow network: recipes emit byproducts (Plastic also
 * yields Heavy Oil Residue) and some pairs are mutually recursive (Recycled
 * Plastic consumes Rubber while Recycled Rubber consumes Plastic). A tree walk
 * either double-counts or loops forever on those; solving the balance equations
 * simultaneously gets them right.
 *
 * Why the dual method: the equivalent equality formulation needs artificial
 * variables and a phase-1 pass, and because almost every row has a zero
 * right-hand side (only target items carry demand) that phase is massively
 * degenerate — in practice it cycles rather than converging. Here the all-slack
 * basis is dual-feasible from the outset precisely because `c >= 0`, so there
 * is no phase 1 to get stuck in. Using `>=` rather than `=` also makes surplus
 * representable directly, so byproducts need no extra variables: the slack on
 * each row *is* the leftover.
 */

export type SimplexStatus = 'optimal' | 'infeasible' | 'iteration-limit'

export interface SimplexResult {
  status: SimplexStatus
  /** Values of the structural variables, length n. */
  x: number[]
  /** Surplus on each constraint: (A x - b) per row, length m. */
  surplus: number[]
  objective: number
  iterations: number
}

const EPS = 1e-9
/** How negative a basic value may be before its row counts as infeasible. */
const FEAS_TOL = 1e-7

interface Tableau {
  rows: Float64Array[]
  basis: number[]
  m: number
  width: number
}

/** One pivot step: make column `col` a unit vector with 1 at `row`. */
function pivot(t: Tableau, row: number, col: number): void {
  const pivotRow = t.rows[row]
  const pv = pivotRow[col]
  for (let j = 0; j < t.width; j++) pivotRow[j] /= pv
  pivotRow[col] = 1 // guard against drift

  for (let i = 0; i <= t.m; i++) {
    if (i === row) continue
    const r = t.rows[i]
    const factor = r[col]
    if (factor === 0) continue
    for (let j = 0; j < t.width; j++) r[j] -= factor * pivotRow[j]
    r[col] = 0
  }
  t.basis[row] = col
}

export function solveLP(
  A: number[][],
  b: number[],
  c: number[],
  maxIter = 20000
): SimplexResult {
  const m = A.length
  const n = c.length
  if (m === 0) {
    return { status: 'optimal', x: new Array(n).fill(0), surplus: [], objective: 0, iterations: 0 }
  }

  // Rows are stored negated: -A x + s = -b, so s = A x - b is the surplus and
  // the slack basis starts at s_i = -b_i: primal-infeasible, dual-feasible.
  const width = n + m + 1
  const rhsCol = width - 1
  const rows: Float64Array[] = []
  for (let i = 0; i <= m; i++) rows.push(new Float64Array(width))

  for (let i = 0; i < m; i++) {
    const row = rows[i]
    const src = A[i]
    for (let j = 0; j < n; j++) row[j] = -(src[j] ?? 0)
    row[n + i] = 1
    row[rhsCol] = -(b[i] ?? 0)
  }

  const basis = new Array<number>(m)
  for (let i = 0; i < m; i++) basis[i] = n + i

  // With an all-slack basis the reduced costs are simply c, already >= 0.
  const obj = rows[m]
  for (let j = 0; j < n; j++) obj[j] = c[j]

  const t: Tableau = { rows, basis, m, width }
  let iterations = 0

  while (iterations < maxIter) {
    iterations++

    // --- leaving row: the most negative basic value ---
    let row = -1
    let worst = -FEAS_TOL
    for (let i = 0; i < m; i++) {
      const v = rows[i][rhsCol]
      if (v < worst) {
        worst = v
        row = i
      }
    }
    if (row < 0) break // primal feasible; dual feasibility then gives optimality

    // --- entering column: dual ratio test ---
    // Only columns with a negative coefficient in this row can lift the basic
    // value back towards zero. Ties break on the lowest column index, the dual
    // analogue of Bland's rule, which keeps the iteration finite.
    const pivotRow = rows[row]
    let col = -1
    let bestRatio = Infinity
    for (let j = 0; j < n + m; j++) {
      const a = pivotRow[j]
      if (a >= -EPS) continue
      const ratio = obj[j] / -a
      if (ratio < bestRatio - EPS) {
        bestRatio = ratio
        col = j
      }
    }
    if (col < 0) {
      // Nothing can repair this row, so the constraints cannot all be met.
      return { status: 'infeasible', x: [], surplus: [], objective: 0, iterations }
    }

    pivot(t, row, col)
  }

  if (iterations >= maxIter) {
    return { status: 'iteration-limit', x: [], surplus: [], objective: 0, iterations }
  }

  const x = new Array<number>(n).fill(0)
  const surplus = new Array<number>(m).fill(0)
  for (let i = 0; i < m; i++) {
    const v = basis[i]
    const value = Math.max(0, rows[i][rhsCol])
    if (v < n) x[v] = value
    else surplus[v - n] = value
  }

  let objective = 0
  for (let j = 0; j < n; j++) objective += c[j] * x[j]

  return { status: 'optimal', x, surplus, objective, iterations }
}
