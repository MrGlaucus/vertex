import { get, post } from '../util/axios';

export default {
  list: () => get('/api/downloaderGroup/list'),
  save: group => post('/api/downloaderGroup/' + (group.id ? 'modify' : 'add'), group),
  delete: id => post('/api/downloaderGroup/delete', { id })
};
