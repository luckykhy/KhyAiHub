// 多端安装包清单。后端 routes/downloads.js 是唯一真源（产物目录、大小、发布页兜底
// 都在那里解析），前端只负责把「有 / 没有 / 后端不可达」三种状态如实画出来。
import request from '@/api/request';
import { unwrap } from '@/api/unwrap';

export const downloadsApi = {
  list() {
    return request.get('/api/downloads/list').then(unwrap);
  },
};
