<template>
  <div class="brush-center">
    <a-space style="margin-bottom: 16px;">
      <span style="font-size: 24px; font-weight: bold;">刷流中心</span>
      <a-button :loading="loading" @click="refresh">刷新</a-button>
    </a-space>
    <a-alert v-if="data.pendingRestore" type="warning" message="有已校验的恢复包等待下次启动切换，旧数据将保留。" />
    <a-tabs>
      <a-tab-pane key="clients" tab="容量与负载">
        <a-table :columns="clientColumns" :data-source="data.clients" row-key="id" :pagination="false" :scroll="{ x: 960 }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'status'">{{ record.status ? '在线' : '离线' }}</template>
            <template v-if="column.key === 'capacity'">{{ record.capacity.count }} / 预占 {{ record.capacity.reserved }} / 待核实 {{ record.capacity.uncertain }}</template>
            <template v-if="column.key === 'space'">{{ bytes(record.capacity.free) }}</template>
            <template v-if="column.key === 'mode'">{{ record.capacity.mode === 'relaxed' ? '宽松' : '严格' }}</template>
            <template v-if="column.key === 'speed'">↑ {{ bytes(record.uploadSpeed) }}/s ↓ {{ bytes(record.downloadSpeed) }}/s</template>
            <template v-if="column.key === 'time'">{{ time(record.updatedAt) }}</template>
          </template>
        </a-table>
      </a-tab-pane>
      <a-tab-pane key="jobs" tab="添加与恢复">
        <a-alert type="info" show-icon message="RSS 添加失败后每 30 秒自动重试，最多重试 5 次；条目离开 RSS 后仍可重试。重试前核实原下载器并检查当前规则。停止恢复不会撤回已发出的请求。" style="margin-bottom: 12px;" />
        <a-input v-model:value="search" placeholder="按名称、下载器、RSS 或状态筛选" style="margin-bottom: 12px;" />
        <a-table :columns="jobColumns" :data-source="filteredJobs" row-key="id" size="small" :scroll="{ x: 1200 }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'state'">{{ states[record.state] || record.state }}</template>
            <template v-if="column.key === 'next'">{{ time(record.nextAt) }}</template>
            <template v-if="column.key === 'actions'">
              <a-space><a-button size="small" :disabled="record.state === 'done'" @click="action(record.id, record.state === 'verificationFailed' ? 'recheck' : 'retry')">{{ record.state === 'verificationFailed' ? '重新校验' : '核实 / 重试' }}</a-button><a-button size="small" :disabled="['done', 'stopped'].includes(record.state)" @click="action(record.id, 'stop')">停止恢复</a-button></a-space>
            </template>
          </template>
        </a-table>
      </a-tab-pane>
      <a-tab-pane key="retries" tab="RSS 自动重试">
        <a-alert type="info" message="首次失败后最多重试 5 次，每次间隔 30 秒。下载器离线或结果无法核实时等待；当前规则不允许添加时停止。详细过程见执行记录。" style="margin-bottom: 12px;" />
        <a-table :data-source="data.retries" :columns="retryColumns" row-key="id" :scroll="{ x: 1000 }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'state'">{{ retryStates[record.state] || record.state }}</template>
            <template v-if="column.key === 'next'">{{ time(record.nextAt) }}</template>
            <template v-if="column.key === 'actions'"><a-button size="small" :disabled="record.state !== 'waiting'" @click="action(record.id, 'stopRetry')">停止重试</a-button></template>
          </template>
        </a-table>
      </a-tab-pane>
      <a-tab-pane key="waiting" tab="辅种等待">
        <a-alert type="info" message="移出等待队列后，不再保留已离开 RSS 的条目；条目仍在 RSS 时会继续按任务设置匹配。" style="margin-bottom: 12px;" />
        <a-table :data-source="data.waiting" :columns="waitColumns" row-key="id">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'expiry'">{{ time(record.expiresAt) }}</template>
            <template v-if="column.key === 'actions'"><a-button size="small" @click="action(record.id, 'cancelWait')">移出队列</a-button></template>
          </template>
        </a-table>
      </a-tab-pane>
      <a-tab-pane key="delete" tab="删种预览">
        <a-alert type="info" message="预览使用最近一次下载器状态，展示当前规则将执行的操作；不删除种子。自定义 JavaScript 规则应保持无副作用。" style="margin-bottom: 12px;" />
        <a-space style="margin-bottom: 12px;">
          <a-select v-model:value="previewClient" placeholder="选择下载器" style="width: 220px;">
            <a-select-option v-for="client in data.clients" :key="client.id" :value="client.id">{{ client.alias }}</a-select-option>
          </a-select>
          <a-button :disabled="!previewClient" @click="loadPreview">预览</a-button><span>状态时间：{{ time(preview.updatedAt) }}</span>
        </a-space>
        <a-table :data-source="preview.items" :columns="deleteColumns" row-key="hash" :scroll="{ x: 960 }" />
      </a-tab-pane>
      <a-tab-pane key="rules" tab="规则收益">
        <a-alert type="info" message="规则流量与占用来自仍在下载器中的已登记种子，用于观察当前贡献；历史页展示 RSS 的历史记录数据。" style="margin-bottom: 12px;" />
        <a-table :data-source="data.rules" :columns="ruleColumns" row-key="id">
          <template #bodyCell="{ column, record }"><template v-if="['upload', 'download', 'size'].includes(column.dataIndex)">{{ bytes(record[column.dataIndex]) }}</template><template v-if="column.dataIndex === 'yield'">{{ record.size ? (record.upload / record.size).toFixed(2) : '—' }}</template></template>
        </a-table>
        <a-table :data-source="data.history" :columns="historyColumns" row-key="rss_id">
          <template #bodyCell="{ column, record }"><template v-if="['upload', 'download'].includes(column.dataIndex)">{{ bytes(record[column.dataIndex]) }}</template></template>
        </a-table>
      </a-tab-pane>
      <a-tab-pane key="traffic" tab="站点与下载器收益">
        <a-alert type="info" message="流量来自当前仍存在的种子累计值；种子容量为逻辑总量，跨站辅种的共享数据会重复计入，不等同于实际磁盘占用。" style="margin-bottom: 12px;" />
        <a-table :data-source="data.traffic" :columns="trafficColumns" row-key="id" :scroll="{ x: 960 }">
          <template #bodyCell="{ column, record }">
            <template v-if="['upload', 'download', 'size'].includes(column.dataIndex)">{{ bytes(record[column.dataIndex]) }}</template>
            <template v-if="column.dataIndex === 'yield'">{{ record.size ? (record.upload / record.size).toFixed(2) : '—' }}</template>
          </template>
        </a-table>
      </a-tab-pane>
      <a-tab-pane key="events" tab="执行记录">
        <a-table :data-source="data.events" :columns="eventColumns" row-key="id" size="small" :scroll="{ x: 1100 }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'time'">{{ time(record.time) }}</template>
            <template v-if="column.key === 'outcome'">{{ outcomes[record.outcome] || record.outcome }}</template>
            <template v-if="column.key === 'next'">{{ time(record.nextAt) }}</template>
          </template>
        </a-table>
      </a-tab-pane>
    </a-tabs>
  </div>
</template>
<script>
import { get, post } from '../../util/axios';
export default {
  data () {
    const column = (title, dataIndex) => ({ title, dataIndex, key: dataIndex });
    return {
      loading: false,
      search: '',
      previewClient: undefined,
      preview: { items: [] },
      data: { clients: [], jobs: [], events: [], retries: [], rules: [], history: [], waiting: [], traffic: [] },
      retryStates: { waiting: '等待重试', done: '成功', exhausted: '重试 5 次失败，已放弃', stopped: '已停止' },
      states: { sending: '请求中', accepted: '已接受待确认', uncertain: '结果待核实', failed: '等待重试', verifying: '校验中', verificationFailed: '校验失败，已暂停', tags: '标签确认中', done: '完成', stopped: '已停止' },
      outcomes: { retryScheduled: '已安排重试', retryStarted: '开始重试', retrySucceeded: '重试成功', retryExhausted: '重试次数耗尽', retryDeferred: '等待核实后重试', retryStopped: '已停止重试', accepted: '添加已接受', reseedAccepted: '辅种已接受', reseedConfirmed: '辅种已确认', reseedMiss: '辅种未命中', reseedError: '辅种错误', rejected: '分配拒绝', failed: '添加失败', uncertain: '添加结果未知', deleted: '已删种', controlled: '已暂停或限速', waitExpired: '等待已过期' },
      retryColumns: [column('种子', 'name'), column('RSS', 'rss'), column('下载器', 'client'), column('状态', 'state'), column('已重试次数', 'attempts'), column('下次重试', 'next'), column('说明', 'error'), column('操作', 'actions')],
      clientColumns: [column('下载器', 'alias'), column('状态', 'status'), column('下载任务', 'capacity'), column('空间计算模式', 'mode'), column('可用空间（按模式）', 'space'), column('速度', 'speed'), column('状态时间', 'time')],
      jobColumns: [column('种子', 'name'), column('下载器', 'client'), column('RSS', 'rss'), column('模式', 'mode'), column('状态', 'state'), column('添加次数', 'attempts'), column('下次处理', 'next'), column('说明', 'error'), column('操作', 'actions')],
      waitColumns: [column('种子', 'name'), column('RSS', 'rss'), column('过期时间', 'expiry'), column('操作', 'actions')],
      deleteColumns: [column('种子', 'name'), column('命中规则', 'rule'), column('操作', 'action'), column('文件保护原因', 'protectedBy')],
      ruleColumns: [column('规则', 'alias'), column('已接受', 'accepted'), column('已确认辅种', 'reseed'), column('上传量', 'upload'), column('下载量', 'download'), column('种子容量', 'size'), column('上传 / 容量', 'yield')],
      historyColumns: [column('RSS 历史', 'alias'), column('记录数', 'records'), column('拒绝数', 'rejected'), column('记录上传量', 'upload'), column('记录下载量', 'download')],
      trafficColumns: [column('下载器', 'client'), column('站点', 'tracker'), column('种子数', 'count'), column('上传量', 'upload'), column('下载量', 'download'), column('种子容量', 'size'), column('上传 / 容量', 'yield')],
      eventColumns: [column('时间', 'time'), column('种子', 'name'), column('RSS', 'rss'), column('下载器', 'client'), column('结果', 'outcome'), column('重试序号', 'retryAttempt'), column('下次重试', 'next'), column('原因', 'reason')]
    };
  },
  computed: {
    filteredJobs () {
      const text = this.search.toLowerCase();
      return this.data.jobs.filter(job => [job.name, job.client, job.rss, this.states[job.state]].join(' ').toLowerCase().includes(text));
    }
  },
  methods: {
    bytes (value) { return Number.isFinite(Number(value)) ? this.$formatSize(Number(value)) : '未知'; },
    time (value) { return value ? new Date(value).toLocaleString() : '—'; },
    async refresh () {
      this.loading = true;
      try { this.data = (await get('/api/brush/overview')).data; } catch (error) { this.$message().error(error.message); } finally { this.loading = false; }
    },
    async action (id, operation) {
      try { await post('/api/brush/action', { id, operation }); this.$message().success('操作完成'); await this.refresh(); } catch (error) { this.$message().error(error.message); }
    },
    async loadPreview () {
      try { this.preview = (await get('/api/brush/deletePreview?clientId=' + encodeURIComponent(this.previewClient))).data; } catch (error) { this.$message().error(error.message); }
    }
  },
  mounted () { this.refresh(); }
};
</script>
<style scoped>
.brush-center { max-width: 1600px; margin: 0 auto; }
</style>
