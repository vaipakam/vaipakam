import { describe, expect, it } from 'vitest';
import { parseSettingsFields } from './useSettingsFields';

describe('parseSettingsFields', () => {
  it('reads the fields the service names, keeping only those this app knows', () => {
    expect(parseSettingsFields(200, { fields: ['vault-outflow', 'later-thing'] })).toEqual(['vault-outflow']);
    expect(parseSettingsFields(200, { fields: [] })).toEqual([]);
  });
  it('reads a bare 404 as a service from before the route, which keeps none', () => {
    expect(parseSettingsFields(404, null)).toEqual([]);
    expect(parseSettingsFields(404, { message: 'not found' })).toEqual([]);
  });
  it('does not read a refusal with its own code, a failure or a strange shape as an answer', () => {
    expect(parseSettingsFields(404, { error: 'not-here' })).toBeNull();
    expect(parseSettingsFields(500, { fields: ['vault-outflow'] })).toBeNull();
    expect(parseSettingsFields(200, { fields: 'vault-outflow' })).toBeNull();
    expect(parseSettingsFields(200, { fields: [1] })).toBeNull();
  });
});
