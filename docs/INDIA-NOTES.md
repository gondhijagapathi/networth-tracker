# India Notes

Domain reference for why this app is shaped the way it is. Everything here is
**informational, not financial or legal advice** — rules change, and the app labels every
computed tax figure as an estimate.

## Why a general-purpose tracker does not fit

Indian household wealth sits in instruments most trackers cannot model:

| Instrument | What makes it awkward |
| ---------- | --------------------- |
| PPF | 15-year lock-in, ₹500 minimum per FY, ₹1.5L cap, extendable in 5-year blocks |
| EPF / VPF | Identified by UAN + member ID, not an account number; employer + employee split |
| NPS | PRAN, Tier I (locked) vs Tier II (liquid), scheme-mix allocation |
| SSY | Per-girl-child, deposit until year 15, matures at 21 |
| Post office | NSC, KVP, MIS, SCSS — each with its own compounding and payout rules |
| Mutual funds | Tracked by **AMFI scheme code** and folio, not a ticker |
| Equity | Held in a demat account (DP ID + client ID, CDSL or NSDL) |
| SGB | 8-year tenor, 2.5% interest paid half-yearly, tax-free capital gain on maturity |
| Gold | Physical grams with purity and making charges; jewellery ≠ investment value |
| Land | Survey number, khata/patta, sub-registrar office; guideline value ≠ market value |
| LIC endowment | Has surrender and maturity value; a *term* policy has none but still matters to heirs |
| Chit funds | Informal, common, and invisible to every other tracker |

## The unclaimed-wealth problem

This is the motivating problem behind the vault and claim-kit features.

A very large amount of Indian household wealth goes unclaimed after a death, for three
mundane reasons: **heirs do not know the asset exists**, **no nominee was registered**, or
**the paperwork cannot be found**. The scale is such that the RBI runs a dedicated portal
(UDGAM) for unclaimed deposits, unclaimed shares and dividends are transferred to the
**IEPF**, and insurers publish unclaimed-amount registers.

The app attacks all three causes:

1. **Inventory** — every asset in one place, so heirs know what exists.
2. **Nomination hygiene dashboard** — flags every asset with no registered nominee, ranked
   by value at risk. Registration is free and takes minutes; not doing it costs years.
3. **Claim kit** — a printable pack per institution with account identifiers, the registered
   nominee, where the physical papers are, and the exact forms required.

### Nomination is not inheritance

Worth stating in the UI, because it is widely misunderstood: a nominee is a **trustee/
receiver**, not necessarily the legal owner. Succession law (or a will) decides ownership.
Registering a nominee makes the claim *fast*; a will makes it *correct*. The app tracks both.

### Claim forms by institution

Reference for the claim-kit generator. Always verify against the institution's current
forms — these are starting points, not guarantees.

| Asset | Typical route |
| ----- | ------------- |
| Bank deposit | Death certificate + nominee KYC + the bank's claim form (DA-1 / DA-2 family) |
| Mutual fund | Transmission request to the RTA (CAMS / KFintech) + death certificate + KYC |
| Demat / shares | Transmission form to the DP + death certificate + client master |
| LIC | Claim forms (3783 / 3801 family) + death certificate + policy document |
| EPF | Form 20 (PF), Form 10D (pension), Form 5-IF (EDLI) |
| NPS | Withdrawal form to the CRA via the POP |
| Property | Succession certificate / legal heir certificate + mutation at the local body |

Above certain thresholds, or with no nominee registered, a **succession certificate** or
**legal heir certificate** is usually required — which is exactly the slow, expensive path
the nomination dashboard exists to help households avoid.

## Financial year and tax

- **FY runs 1 April – 31 March.** All reporting defaults to FY, labelled with the assessment
  year (FY 2026-27 → AY 2027-28).
- **Equity / equity MF**: short-term under 12 months, long-term at or beyond it. The app
  computes the split and applies the long-term exemption threshold to unrealized gains so
  you can see the boundary before you sell.
- **Debt mutual funds** purchased on or after 1 April 2023 are taxed at slab rates
  regardless of holding period — no indexation. The app models purchase date accordingly.
- **FD interest** is taxable on accrual, with TDS above a threshold; Form 15G/15H avoids
  deduction for those eligible. The app surfaces accrued-but-unpaid interest, which
  bank statements hide until payout.
- **Section 80C** (₹1.5L): PPF + ELSS + LIC premium + SSY + home-loan principal + tuition.
  The app tracks the bucket so you can see the headroom before 31 March.
- **Section 80D**: health insurance premium, with a higher limit for senior-citizen parents.

Rates and thresholds are kept in one configuration module per FY so a Budget change is a
data edit rather than a code change.

## Number formatting

Indian digit grouping is **2-2-3**, not 3-3-3: `₹1,23,45,678`. Use
`Intl.NumberFormat('en-IN')`. Provide a compact toggle for lakh (`₹1.23 L`) and crore
(`₹1.23 Cr`) — that is how the numbers are actually spoken and read.

## Data sources

- **AMFI NAV** — `https://portal.amfiindia.com/spages/NAVAll.txt`, a daily semicolon-
  delimited dump: `Scheme Code;ISIN Payout;ISIN Reinvest;Scheme Name;NAV;Date`. Free, no key,
  covers roughly 38,000 schemes. This is the backbone of mutual fund valuation.
- **Equity prices** — NSE and BSE publish no official free REST API. Market data flows
  through licensed vendors, broker APIs (Zerodha Kite, ICICI Breeze, Upstox) and
  aggregators. The default provider is best-effort and degrades to manual entry; users who
  have a broker API key can plug it in.
- **CAS import** (backlog) — CAMS/KFintech and NSDL/CDSL consolidated account statements are
  password-protected PDFs that would let a user bulk-load their entire portfolio in one
  step. High value, meaningful parsing effort.
