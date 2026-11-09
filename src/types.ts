export type ZendeskCategory = {
  id: number;
  name: string;
  description: string | null;
  htmlUrl: string | null;
  position: number;
};

export type ZendeskSection = {
  id: number;
  name: string;
  description: string | null;
  htmlUrl: string | null;
  categoryId: number | null;
  parentSectionId: number | null;
  position: number;
};

export type ZendeskArticle = {
  id: number;
  title: string;
  body: string | null;
  /** True when Zendesk says this locale's translation is a draft. */
  draft: boolean | null;
  htmlUrl: string | null;
  sectionId: number | null;
  position: number;
};

export type ZendeskHelpCenter = {
  categories: ZendeskCategory[];
  sections: ZendeskSection[];
  articles: ZendeskArticle[];
};

export type Mapping = {
  version: 1;
  helpCenterId: string;
  zendeskSubdomain: string;
  locale: string;
  updatedAt: string;
  categories: Record<string, string>;
  sections: Record<string, string>;
  articles: Record<string, string>;
};

export type ParentRef = {
  kind: 'category' | 'section';
  zendeskId: number;
};

export type GroupAction = {
  action: 'create' | 'update';
  kind: 'category' | 'section';
  zendeskId: number;
  name: string;
  slug: string;
  description: string | null;
  parent: ParentRef | null;
  categoryZendeskId: number | null;
  plainId?: string;
};

export type ArticleAction = {
  action: 'create' | 'update';
  kind: 'article';
  zendeskId: number;
  title: string;
  slug: string;
  status: 'DRAFT' | 'PUBLISHED';
  contentHtml: string;
  sectionId: number | null;
  plainId?: string;
};

export type SkipAction = {
  action: 'skip';
  kind: 'category' | 'section' | 'article';
  zendeskId: number;
  title: string;
  reason: string;
};

export type PlannedAction = GroupAction | ArticleAction | SkipAction;

export type PlanSummary = {
  source: { categories: number; sections: number; articles: number };
  dropped: { categories: number; sections: number; articles: number };
  create: number;
  update: number;
  skip: number;
};

export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};
