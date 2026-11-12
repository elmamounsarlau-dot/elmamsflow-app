/** The carrier's own tracking page for a parcel (no tracking service in between). */

const PAGES: [RegExp, (n: string) => string][] = [
  [/yun ?express|yuntrack/i, (n) => `https://www.yuntrack.com/parcelTracking?id=${n}`],
  [/4px/i, (n) => `https://track.4px.com/#/result/0/${n}`],
  [/\bcne\b|cne express/i, (n) => `https://www.cne.com/English/?no=${n}`],
  [/yanwen/i, (n) => `https://track.yw56.com.cn/en/querydel?nums=${n}`],
  [/cainiao|aliexpress/i, (n) => `https://global.cainiao.com/newDetail.htm?mailNoList=${n}`],
  [/sf ?express|顺丰/i, (n) => `https://www.sf-express.com/chn/en/dynamic_function/waybill/#search/bill-number/${n}`],
  [/\bdhl\b/i, (n) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${n}`],
  [/\bups\b/i, (n) => `https://www.ups.com/track?tracknum=${n}`],
  [/fedex/i, (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`],
  [/usps/i, (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`],
  [/royal ?mail/i, (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${n}`],
  [/evri|hermes/i, (n) => `https://www.evri.com/track/parcel/${n}/details`],
  [/canada ?post/i, (n) => `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${n}`],
  [/australia ?post|auspost/i, (n) => `https://auspost.com.au/mypost/track/details/${n}`],
  [/postnl/i, (n) => `https://jouw.postnl.nl/track-and-trace/${n}`],
  [/colissimo|la ?poste/i, (n) => `https://www.laposte.fr/outils/suivre-vos-envois?code=${n}`],
  [/\bgls\b/i, (n) => `https://gls-group.com/track/${n}`],
  [/\bdpd\b/i, (n) => `https://tracking.dpd.de/status/en_US/parcel/${n}`],
];

/** Best page to follow this parcel: the one the warehouse gave us, else the carrier's, else a neutral multi-carrier page. */
export function trackingLink(carrier: string | null | undefined, number: string | null | undefined, given?: string | null) {
  if (!number) return null;
  if (given && /^https:\/\//i.test(given) && !/17track\.net/i.test(given)) return given;
  const n = encodeURIComponent(number);
  for (const [re, f] of PAGES) if (carrier && re.test(carrier)) return f(n);
  return `https://parcelsapp.com/en/tracking/${n}`;
}
