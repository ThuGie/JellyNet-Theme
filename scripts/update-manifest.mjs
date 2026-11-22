import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const [archive, notes] = process.argv.slice(2);
const { GITHUB_REPOSITORY: repository, GITHUB_REF_NAME: tag, GITHUB_SERVER_URL: host } = process.env;
const version = tag?.slice(1);
const guid = '7b51fc65-1948-4858-b071-1ba39709d88f';
if (!archive || !notes || !repository || !host || !/^v\d+\.\d+\.\d+\.\d+$/.test(tag ?? '')
    || basename(archive) !== `JellyNet-${version}.zip`) {
  throw new Error('Expected a tagged GitHub build and the matching JellyNet ZIP.');
}
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
let plugin = manifest.find(entry => entry.guid === guid);
if (!plugin) {
  plugin = {
    guid, name: 'JellyNet',
    description: 'A Jellyfin Web theme with personal home shelves, category browsing, and plugin navigation.',
    overview: 'Personalize your Jellyfin Web home.',
    owner: repository.split('/')[0], category: 'General', versions: []
  };
  manifest.push(plugin);
}
const checksum = createHash('md5').update(readFileSync(archive)).digest('hex');
const previous = plugin.versions.find(entry => entry.version === version);
if (previous && previous.checksum !== checksum) throw new Error('The existing manifest checksum does not match the published ZIP.');
if (!previous) {
  plugin.versions.push({
    version, changelog: readFileSync(notes, 'utf8').trim() || `JellyNet ${version}`,
    targetAbi: '12.4.0.0',
    sourceUrl: `${host}/${repository}/releases/download/${tag}/${basename(archive)}`,
    checksum, timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  });
  plugin.versions.sort((left, right) => right.version.localeCompare(left.version, 'en', { numeric: true }));
  writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
}
