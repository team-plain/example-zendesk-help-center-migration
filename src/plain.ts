import { ScriptError } from './errors';
import { requestJson } from './http';
import type { Logger } from './types';

const CREATE_GROUP = `mutation CreateHelpCenterArticleGroup($input: CreateHelpCenterArticleGroupInput!) {
  createHelpCenterArticleGroup(input: $input) {
    helpCenterArticleGroup { id }
    error { message type code fields { field message type } }
  }
}`;

const UPDATE_GROUP = `mutation UpdateHelpCenterArticleGroup($input: UpdateHelpCenterArticleGroupInput!) {
  updateHelpCenterArticleGroup(input: $input) {
    helpCenterArticleGroup { id }
    error { message type code fields { field message type } }
  }
}`;

const UPSERT_ARTICLE = `mutation UpsertHelpCenterArticle($input: UpsertHelpCenterArticleInput!) {
  upsertHelpCenterArticle(input: $input) {
    helpCenterArticle { id }
    error { message type code fields { field message type } }
  }
}`;

export type CreateGroupInput = {
  helpCenterId: string;
  name: string;
  slug: string;
  parentHelpCenterArticleGroupId?: string;
};

export type UpdateGroupInput = {
  helpCenterArticleGroupId: string;
  name: string;
  description: string | null;
};

export type UpsertArticleInput = {
  helpCenterId: string;
  helpCenterArticleId?: string;
  helpCenterArticleGroupId: string | null;
  title: string;
  contentHtml: string;
  slug: string;
  status: 'DRAFT' | 'PUBLISHED';
};

export class PlainClient {
  constructor(
    private readonly options: {
      apiKey: string;
      apiUrl: string;
      fetchImpl?: typeof fetch;
      logger: Logger;
    },
  ) {}

  async createArticleGroup(input: CreateGroupInput): Promise<string> {
    const data = await this.mutate(CREATE_GROUP, 'CreateHelpCenterArticleGroup', { input }, false);
    return readId(data, 'createHelpCenterArticleGroup', 'helpCenterArticleGroup');
  }

  /**
   * Create has no description field. Description is a separate update.
   * Updates also cannot change slug or parent.
   */
  async updateArticleGroup(input: UpdateGroupInput): Promise<void> {
    await this.mutate(UPDATE_GROUP, 'UpdateHelpCenterArticleGroup', { input }, true);
  }

  async upsertArticle(input: UpsertArticleInput): Promise<string> {
    const data = await this.mutate(
      UPSERT_ARTICLE,
      'UpsertHelpCenterArticle',
      { input },
      input.helpCenterArticleId != null,
    );
    return readId(data, 'upsertHelpCenterArticle', 'helpCenterArticle');
  }

  private async mutate(
    query: string,
    operationName: string,
    variables: Record<string, unknown>,
    retryServerErrors: boolean,
  ): Promise<Record<string, unknown>> {
    const response = await requestJson({
      fetchImpl: this.options.fetchImpl ?? fetch,
      url: this.options.apiUrl,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({ query, variables, operationName }),
      },
      logger: this.options.logger,
      what: `Plain ${operationName}`,
      retryServerErrors,
    });

    const body = asRecord(response.body, `Plain ${operationName}`);
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const message = body.errors
        .map((error) => (isRecord(error) && typeof error.message === 'string' ? error.message : 'GraphQL error'))
        .join('; ');
      throw new ScriptError(`Plain ${operationName} failed: ${message}`);
    }
    if (!isRecord(body.data)) {
      throw new ScriptError(`Plain ${operationName} returned no data`);
    }
    return body.data;
  }
}

type MutationError = {
  message: string;
  type: string;
  code: string;
  fields: { field: string; message: string; type: string }[];
};

function readId(data: Record<string, unknown>, field: string, entity: string): string {
  const payload = data[field];
  if (!isRecord(payload)) throw new ScriptError(`Plain ${field} returned no payload`);
  if (payload.error != null) {
    throw new ScriptError(`Plain ${field} failed: ${formatMutationError(payload.error)}`);
  }
  const record = payload[entity];
  if (!isRecord(record) || typeof record.id !== 'string' || record.id === '') {
    throw new ScriptError(`Plain ${field} returned no ${entity} id`);
  }
  return record.id;
}

function formatMutationError(value: unknown): string {
  if (!isRecord(value)) return 'unknown mutation error';
  const error = value as Partial<MutationError>;
  const fields = Array.isArray(error.fields)
    ? error.fields
        .map((field) =>
          isRecord(field) && typeof field.field === 'string' && typeof field.message === 'string'
            ? `${field.field}: ${field.message}`
            : '',
        )
        .filter(Boolean)
        .join('; ')
    : '';
  const code = typeof error.code === 'string' ? error.code : 'error';
  const message = typeof error.message === 'string' ? error.message : 'mutation failed';
  return fields ? `${code} ${message} (${fields})` : `${code} ${message}`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ScriptError(`${label} is not an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
