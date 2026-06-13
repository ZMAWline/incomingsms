# Go-To-Market Plan — SMS Day-Rental Storefront
*Prepared 2026-06-13. Grounded in channel research of textverified.com, smspool.net, sms-activate, 5sim, daisysms (sources in research brief). Placeholder brand "Numbox" used throughout.*

---

## 1. The opening: DaisySMS is dead

DaisySMS — the most-loved US-focused service, famous for ~$0.25/day real-SIM rentals with a full inbox — **shut down March 26, 2026**. Its users are visibly searching for a replacement (BlackHatWorld "Daisy alternative in 2026" threads, YouTube "DaisySMS shut down — best alternative" videos, competitors running dedicated /daisysms-alternative landing pages). The default fallbacks (TextVerified from $1.50 for short rentals, SMSPool $20 long-term) are both *worse deals* for the Daisy-style "give me a number for a day with a full inbox" customer.

**Position: "the DaisySMS-style day rental, back."** Real physical-SIM US numbers (not VoIP), full private inbox for 24h, crypto-friendly, instant.

## 2. Positioning & pricing

**One-liner:** *Private, real-SIM US numbers. Yours for the day — every SMS, one inbox, paid in crypto.*

**Trust pillars (the 4 things every competitor leads with — match all 4):**
1. Real SIM / non-VoIP — platforms increasingly reject VoIP ranges; this is the category's whole premium.
2. Full 24-hour inbox — not one code, *every* message (sharper than TextVerified's per-verification model).
3. Auto-refund if no SMS arrives (TextVerified and SMSPool both lead with this — table stakes).
4. No account dragnet: email + crypto only.

**Pricing (your wholesale anchor: reseller currently pays ~$1.10–1.60/line/day):**
- Launch promo: **$1.99/day** ("Daisy refugees" anchor — undercuts TextVerified's rental floor while >25% above your wholesale).
- Standard: **$2.49–2.99/day**, carrier-tiered (T-Mobile vs AT&T) via the existing `shop_prices` table.
- 7-day bundle at ~15% off to pull repeat use.
- First-rental discount code per channel (doubles as channel attribution — see §6).
- Never compete to the bottom with 5sim/$0.01 activations — different product (shared offshore numbers vs private US line).

**Compliance framing (hard rule):** market *privacy, testing, and account separation*. Never the words "bypass," "fake accounts," or platform names + "unlimited accounts." Press already paints this category as fraud-adjacent; the privacy posture (TextVerified/Daisy style) is the defensible one — and "bypass" copy is exactly what trips Google's "dishonest behavior" ad policy.

## 3. Pre-launch checklist (one day of work)

- [ ] Brand + domain chosen and connected (site is brand-swappable in one file).
- [ ] Terms of Service + **Acceptable Use Policy** (prohibits fraud/illegal use — your legal shield and a trust signal) + refund policy page ("auto-refund if no SMS received in first hour of rental").
- [ ] Support: dedicated email + a Telegram support handle (this audience lives on Telegram).
- [ ] NOWPayments account live (BTC/USDT/XMR — XMR matters to this crowd; TextVerified accepts it).
- [ ] **Trustpilot profile claimed** day one; post-rental email asks for a review. Nobody in this market owns "excellent" (SMS-Activate 2.2★, 5sim 2.2★, SMSPool ~3.5★, TextVerified ~3.9★). A 4.5★ profile with 50 reviews would be the best in the category.
- [ ] 10–20 lines allocated to the shop pool + free-test promo credit mechanism ($0.50 on signup, manual at first).
- [ ] Live stock counter on the landing page (5sim publishes live stats; scarcity + transparency both sell).

## 4. Channels, ranked (what competitors verifiably do)

**Tier 1 — do in week 1 (free or <$50):**
1. **Reddit r/phoneverification [OFFER] thread.** The niche's open marketplace — DaisySMS's own offer thread was the top post of the niche; SMSPool ran "[OFFER] from $0.02" there. Post a clean offer: pricing, refund policy, free test for commenters. Maintain it (answer every comment).
2. **BlackHatWorld Marketplace thread.** SMSPool has sold there openly since 2022. Requirements: Jr VIP or Marketplace Seller status, mod pre-test of your service, ~$30/year listing fee, thread must state pricing/refunds/turnaround. Also reply (helpfully, not spammy) in the "Daisy alternative 2026" and "Big list of SMS providers" threads — those rank in Google.
3. **Telegram channel + announcements.** @yourbrand channel for stock updates, promos, uptime notices (SMSPool's is 2.2K subs and is their promo-code distribution arm). Cheap, on-brand, and pre-work for the phase-2 purchase bot — in this market the **Telegram bot is itself a sales channel** (SMS-Activate sells directly inside Telegram).
4. **/daisysms-alternative landing page** on your site (getatext already runs one; the search demand is live and current). Honest comparison table: Daisy's model vs yours vs TextVerified/SMSPool.

**Tier 2 — weeks 2–4 (compounding):**
5. **Per-service SEO landing pages** — THE proven strategy in this niche (TextVerified /services/telegram; SMSPool per-service pages; 5sim has 1,200+). Generate from one template: "Temporary US number for [Telegram/WhatsApp/Gmail/Discord/Tinder/...]" × your top 20 services. Each page: how-to steps, live stock, price, FAQ.
6. **Affiliate program: 15–20% of referred spend** (benchmarks: SMS-Activate 20% retail; SMSPool 5%×3mo; 5sim flat per-activation). The ledger schema already supports it (add a `referral` ledger kind + ref code). This is how the YouTube micro-reviewer ecosystem gets paid — those "SMSPool review + discount code" videos are all affiliate-driven, no sponsorship needed.
7. **Listicle outreach.** The "best SMS verification 2026" SERP is competitor-owned blogs reviewing themselves. Two moves: pitch the independent-ish ones (voidmob, pixelscan) for inclusion as "the new Daisy-style option," and publish your own ranked comparison on your blog (everyone does).
8. **Trustpilot flywheel:** post-purchase prompt + respond to every review.

**Tier 3 — month 2+:**
9. **Free receive-SMS page** as top-of-funnel (quackr.io model: 4.1★, huge SEO traffic, upsells private numbers). Needs a few sacrificial "burn" numbers with public inboxes. Big traffic, low intent — only after paid funnel works.
10. **YouTube tutorials** of your own ("How to get a US number for X in 2 minutes") — evergreen search traffic.
11. **API + developer docs page** — 5sim/SMSPool win developer volume via API; your reseller API experience makes this cheap. Devs are the highest-LTV segment.

**Do NOT spend on:** Google Ads (virtual-number ads restricted + "dishonest behavior" policy risk; no competitor runs them), Reddit paid ads (gray-zone, ban-on-report), ProductHunt/HN (no competitor has ever landed there; audience hostile to the category).

## 5. Launch sequence

**Week 1 — soft launch:** brand live, 10–20 lines in pool, crypto on, AUP/refunds posted, Trustpilot claimed, Telegram channel up. Post r/phoneverification offer + start BHW vetting. Free-test credit for first 50 signups.
**Week 2:** BHW Marketplace thread live, /daisysms-alternative page indexed, first 10 per-service pages, post-purchase review prompts on.
**Week 4:** affiliate program live (15% launch rate), listicle outreach, top-20 service pages done, evaluate channel data → double down on the best two.
**Month 2:** Telegram purchase bot (phase 2 build — the API tokens already exist per account), free-SMS top-of-funnel page, API docs.

## 6. Measure (or it didn't happen)

Per-channel promo codes (REDDIT10, BHW10, TG10…) + referral codes = channel attribution with zero extra tooling (it's all in `shop_ledger.ref`). Weekly numbers to watch: signups → funded% → first rental% (the money metric), rentals/customer/week (repeat = product-market fit), stock utilization%, refund rate, Trustpilot delta. North star: **funded customers making a 2nd rental within 7 days.**

Capacity note: every shop line must out-earn its wholesale alternative (~$1.10–1.60/day from the reseller). At $2.49/day and >65% utilization the shop wins; below that, lines go back to wholesale. Start small (10–20 lines), let utilization data size the pool.
