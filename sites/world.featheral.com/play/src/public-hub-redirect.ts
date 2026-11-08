import { publicHubTarget } from './world-hub-render.ts';

const target = publicHubTarget(location.pathname);
if (!target) throw new Error('Unknown public World destination.');
const destination = new URL(target, location.origin);
destination.search = location.search;
location.replace(destination.href);
