// ---- Akkaunt (sessiya orqali) ----

export interface OlxUser {
  id: number;
  uuid?: string;
  name: string;
  created?: string;
  last_login?: string;
  last_seen?: string;
  is_business?: boolean;
  is_online?: boolean;
  user_ads_url?: string;
  email?: string;
  message_response_time?: { text?: string | null };
}

export interface AdStats {
  views: number | null;
  observed: number | null;
  phones: number | null;
}

/** GraphQL `myAds` dagi e'lon. */
export interface MyAd {
  id: string | number;
  title: string;
  status: string;
  categoryId?: number;
  price?: number | null;
  priceType?: string | null;
  currency?: string | null;
  photos?: string[];
  validTo?: string | null;
  activatedAt?: string | null;
  lastRefreshAt?: string | null;
  daysToExpire?: number | null;
  canRefreshForFree?: boolean;
  editable?: boolean;
  stats?: AdStats | null;
  messageCounters?: { total: number; new: number } | null;
  location?: { name?: string } | null;
  categoryLevels?: { id: number; name: string; level: number }[];
  statusCause?: string | null;
  vases?: { type?: string; name?: string; validTo?: string }[];
}

// ---- Ochiq (public) API ----

export interface RawOfferParam {
  key: string;
  name: string;
  type: string;
  value: {
    key?: string;
    label?: string;
    value?: number;
    currency?: string;
    negotiable?: boolean;
    converted_value?: number | null;
    converted_currency?: string | null;
  };
}

export interface RawOfferUser {
  id: number;
  name: string;
  created?: string;
  company_name?: string;
  is_online?: boolean;
  last_seen?: string;
}

export interface RawOffer {
  id: number;
  url: string;
  title: string;
  description?: string;
  created_time: string;
  last_refresh_time?: string;
  valid_to_time?: string;
  pushup_time?: string | null;
  business: boolean;
  status?: string;
  promotion?: { highlighted?: boolean; urgent?: boolean; top_ad?: boolean; options?: string[] };
  params?: RawOfferParam[];
  user?: RawOfferUser;
  location?: {
    city?: { id: number; name: string };
    district?: { id: number; name: string };
    region?: { id: number; name: string };
  };
  photos?: unknown[];
  category?: { id: number; type?: string };
  delivery?: { rock?: { active?: boolean } };
}

export interface OffersResponse {
  data: RawOffer[];
  metadata?: {
    total_elements?: number;
    visible_total_count?: number;
    promoted?: number[];
  };
  links?: { next?: { href: string } };
}

export interface FacetItem {
  id: number | string;
  count: number;
  label: string;
}

/** Tahlil uchun soddalashtirilgan e'lon. */
export interface OfferSummary {
  id: number;
  title: string;
  url: string;
  price: number | null;
  currency: string | null;
  price_label: string | null;
  negotiable: boolean;
  condition: string | null;
  business: boolean;
  seller_id: number | null;
  seller_name: string | null;
  seller_since: string | null;
  city: string | null;
  region: string | null;
  district: string | null;
  category_id: number | null;
  created: string;
  refreshed: string | null;
  promoted: boolean;
  promotion: string[];
  photos: number;
  delivery: boolean;
}
