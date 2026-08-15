import { readFileSync } from 'node:fs';

const messages = {
  '@@bidi_dir': { message: 'ltr' },
  ...JSON.parse(
    readFileSync(new URL('./_locales/en/messages.json', import.meta.url)),
  ),
};

export function getMessage(key, substitutions = []) {
  const { message, placeholders = {} } = messages[key];
  const values = [].concat(substitutions);
  return message.replace(/\$(\w+)\$/g, (_, name) => (
    values[Number(placeholders[name].content.slice(1)) - 1]
  ));
}
