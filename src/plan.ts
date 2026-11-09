import { ScriptError } from './errors';
import { claimSlug, slugFromHelpCenterUrl, toContentHtml } from './slug';
import type {
  ArticleAction,
  GroupAction,
  Mapping,
  ParentRef,
  PlanSummary,
  PlannedAction,
  SkipAction,
  ZendeskArticle,
  ZendeskCategory,
  ZendeskHelpCenter,
  ZendeskSection,
} from './types';

export function buildPlan(input: {
  center: ZendeskHelpCenter;
  mapping: Mapping;
  categoryIds: number[] | null;
}): { actions: PlannedAction[]; summary: PlanSummary } {
  assertUnique(input.center.categories, 'category');
  assertUnique(input.center.sections, 'section');
  assertUnique(input.center.articles, 'article');

  const categoryById = new Map(input.center.categories.map((category) => [category.id, category]));
  const sectionById = new Map(input.center.sections.map((section) => [section.id, section]));
  const selectedCategoryIds = input.categoryIds ? new Set(input.categoryIds) : null;

  const categories = input.center.categories.filter((category) =>
    selectedCategoryIds ? selectedCategoryIds.has(category.id) : true,
  );
  const includedCategoryIds = new Set(categories.map((category) => category.id));

  const sections = input.center.sections.filter((section) =>
    sectionIsSelected(section, sectionById, selectedCategoryIds),
  );
  const includedSectionIds = new Set(sections.map((section) => section.id));

  const articles: ZendeskArticle[] = [];
  const skippedArticles: SkipAction[] = [];
  for (const article of input.center.articles) {
    if (article.sectionId == null) {
      if (selectedCategoryIds) continue;
      articles.push(article);
      continue;
    }
    const section = sectionById.get(article.sectionId);
    if (!section) {
      skippedArticles.push({
        action: 'skip',
        kind: 'article',
        zendeskId: article.id,
        title: article.title,
        reason: `section ${article.sectionId} was not in the Zendesk response`,
      });
      continue;
    }
    if (includedSectionIds.has(section.id)) articles.push(article);
  }

  const actions: PlannedAction[] = [];
  const usedSlugs = new Set<string>();

  if (selectedCategoryIds) {
    for (const id of selectedCategoryIds) {
      if (!categoryById.has(id)) {
        actions.push({
          action: 'skip',
          kind: 'category',
          zendeskId: id,
          title: `Category ${id}`,
          reason: 'not returned by Zendesk',
        });
      }
    }
  }

  const orderedCategories = [...categories].sort(byPosition);
  for (const category of orderedCategories) {
    actions.push(groupAction(category, 'category', null, null, input.mapping.categories, usedSlugs));
  }

  const skippedSections: SkipAction[] = [];
  const placeable: ZendeskSection[] = [];
  for (const section of orderSections(sections)) {
    const parent = parentFor(section, includedSectionIds, includedCategoryIds);
    if (parent === 'skip') {
      skippedSections.push({
        action: 'skip',
        kind: 'section',
        zendeskId: section.id,
        title: section.name,
        reason:
          section.categoryId == null
            ? 'parent section was not imported'
            : `category ${section.categoryId} was not in the Zendesk response`,
      });
      includedSectionIds.delete(section.id);
      continue;
    }
    placeable.push(section);
    actions.push(
      groupAction(section, 'section', parent, section.categoryId, input.mapping.sections, usedSlugs),
    );
  }

  const orderedArticles = [...articles].sort(byPosition);
  const articleActions: ArticleAction[] = [];
  for (const article of orderedArticles) {
    if (article.sectionId != null && !includedSectionIds.has(article.sectionId)) {
      skippedArticles.push({
        action: 'skip',
        kind: 'article',
        zendeskId: article.id,
        title: article.title,
        reason: `section ${article.sectionId} was not imported`,
      });
      continue;
    }
    articleActions.push(articleAction(article, input.mapping.articles, usedSlugs));
  }

  actions.push(...skippedSections, ...articleActions, ...skippedArticles);

  const droppedCategories = input.center.categories.length - categories.length;
  const droppedSections = input.center.sections.length - sections.length;
  const droppedArticles =
    input.center.articles.length - articles.length - skippedArticles.length;

  return {
    actions,
    summary: {
      source: {
        categories: input.center.categories.length,
        sections: input.center.sections.length,
        articles: input.center.articles.length,
      },
      dropped: {
        categories: droppedCategories,
        sections: droppedSections,
        articles: Math.max(0, droppedArticles),
      },
      create: actions.filter((action) => action.action === 'create').length,
      update: actions.filter((action) => action.action === 'update').length,
      skip: actions.filter((action) => action.action === 'skip').length,
    },
  };
}

function groupAction(
  entity: ZendeskCategory | ZendeskSection,
  kind: 'category' | 'section',
  parent: ParentRef | null,
  categoryZendeskId: number | null,
  table: Record<string, string>,
  usedSlugs: Set<string>,
): GroupAction {
  const slug = claimSlug(slugFromHelpCenterUrl(entity.htmlUrl, entity.id, entity.name), entity.id, usedSlugs);
  const plainId = table[String(entity.id)];
  const action: GroupAction = {
    action: plainId ? 'update' : 'create',
    kind,
    zendeskId: entity.id,
    name: entity.name,
    slug,
    description: entity.description,
    parent,
    categoryZendeskId,
  };
  if (plainId) action.plainId = plainId;
  return action;
}

function articleAction(
  article: ZendeskArticle,
  table: Record<string, string>,
  usedSlugs: Set<string>,
): ArticleAction {
  const slug = claimSlug(slugFromHelpCenterUrl(article.htmlUrl, article.id, article.title), article.id, usedSlugs);
  const plainId = table[String(article.id)];
  const action: ArticleAction = {
    action: plainId ? 'update' : 'create',
    kind: 'article',
    zendeskId: article.id,
    title: article.title,
    slug,
    // A missing draft flag must not publish. Public responses include draft: false.
    status: article.draft === false ? 'PUBLISHED' : 'DRAFT',
    contentHtml: toContentHtml(article.body),
    sectionId: article.sectionId,
  };
  if (plainId) action.plainId = plainId;
  return action;
}

function sectionIsSelected(
  section: ZendeskSection,
  sectionById: Map<number, ZendeskSection>,
  selectedCategoryIds: Set<number> | null,
): boolean {
  if (!selectedCategoryIds) return true;
  const categoryId = resolveCategoryId(section, sectionById);
  return categoryId != null && selectedCategoryIds.has(categoryId);
}

function resolveCategoryId(
  section: ZendeskSection,
  sectionById: Map<number, ZendeskSection>,
): number | null {
  const seen = new Set<number>();
  let current: ZendeskSection | undefined = section;
  while (current) {
    if (seen.has(current.id)) return current.categoryId;
    seen.add(current.id);
    if (current.categoryId != null) return current.categoryId;
    if (current.parentSectionId == null) return null;
    current = sectionById.get(current.parentSectionId);
  }
  return null;
}

function parentFor(
  section: ZendeskSection,
  includedSectionIds: Set<number>,
  includedCategoryIds: Set<number>,
): ParentRef | null | 'skip' {
  if (section.parentSectionId != null && includedSectionIds.has(section.parentSectionId)) {
    return { kind: 'section', zendeskId: section.parentSectionId };
  }
  if (section.categoryId != null && includedCategoryIds.has(section.categoryId)) {
    return { kind: 'category', zendeskId: section.categoryId };
  }
  if (section.categoryId == null && section.parentSectionId == null) return null;
  return 'skip';
}

function orderSections(sections: ZendeskSection[]): ZendeskSection[] {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const ordered = [...sections].sort(byPosition);
  const result: ZendeskSection[] = [];
  const visiting = new Set<number>();
  const done = new Set<number>();

  const visit = (section: ZendeskSection): void => {
    if (done.has(section.id) || visiting.has(section.id)) return;
    visiting.add(section.id);
    if (section.parentSectionId != null) {
      const parent = byId.get(section.parentSectionId);
      if (parent) visit(parent);
    }
    visiting.delete(section.id);
    done.add(section.id);
    result.push(section);
  };

  for (const section of ordered) visit(section);
  return result;
}

function byPosition(left: { position: number; id: number }, right: { position: number; id: number }): number {
  return left.position - right.position || left.id - right.id;
}

function assertUnique(items: { id: number }[], label: string): void {
  const seen = new Set<number>();
  for (const item of items) {
    if (seen.has(item.id)) throw new ScriptError(`Duplicate Zendesk ${label} id ${item.id}`);
    seen.add(item.id);
  }
}
