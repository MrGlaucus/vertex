<template>
  <div class="brush-center">
    <header class="page-header">
      <div><h1>刷流中心</h1><p class="muted">查看下载器状态、处理异常任务，以及了解刷流收益。</p></div>
      <a-space><span class="muted">{{ refreshedAt ? '刷新于 ' + time(refreshedAt) : '尚未加载' }}</span><a-button :loading="loading" @click="refresh">刷新数据</a-button></a-space>
    </header>
    <a-alert v-if="loadError" type="error" show-icon :message="loadError" description="当前保留上次成功加载的数据，请刷新重试。" class="notice" />
    <a-alert v-if="data.pendingRestore" type="warning" show-icon message="备份恢复等待生效" description="恢复包已经校验，将在下次启动时切换；旧数据会保留。" class="notice" />
    <a-tabs v-model:activeKey="section">
      <a-tab-pane key="overview" tab="总览">
        <div class="summary-grid">
          <button v-for="card in summaryCards" :key="card.key" class="summary-card" @click="navigate(card.section, card.kind)"><span class="muted">{{ card.title }}</span><strong :class="{ warning: card.warning }">{{ card.value }}</strong><span class="muted">{{ card.description }} →</span></button>
        </div>
        <section class="panel">
          <div class="section-heading"><div><h2>先处理这些事项</h2><p class="muted">汇总状态异常的下载器、重试耗尽和校验失败的任务，点击查看原因及处理方式。</p></div><a-button @click="navigate('tasks', 'retries')">查看任务</a-button></div>
          <div v-if="attentionItems.length" class="attention-list">
            <button v-for="item in attentionItems.slice(0, 8)" :key="item.key" class="attention-item" @click="inspectAttention(item)"><a-tag color="error">{{ item.label }}</a-tag><div class="attention-copy"><strong>{{ item.name }}</strong><span class="muted">{{ item.reason }}</span></div><span class="muted">查看 →</span></button>
            <p v-if="attentionItems.length > 8" class="muted">另有 {{ attentionItems.length - 8 }} 项，请到任务处理查看。</p>
          </div>
          <div v-else class="empty-state"><strong>当前列表中没有需要人工处理的异常</strong><span class="muted">自动重试、辅种校验和等待源数据的任务仍会在后台处理。</span></div>
        </section>
        <section class="panel">
          <div class="section-heading"><div><h2>下载器能否继续接种？</h2><p class="muted">下载名额包含待确认请求。可用空间按每台下载器的严格或宽松模式计算。</p></div><a-button @click="$router.push('/base/downloader')">配置下载器</a-button></div>
          <a-table :columns="clientColumns" :data-source="data.clients" row-key="id" size="small" :pagination="false" :scroll="{ x: 1100 }" :locale="{ emptyText: '暂无已启用的下载器，请先配置下载器。' }">
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'status'"><a-tag :color="record.status ? 'success' : 'error'">{{ record.status ? '状态正常' : '状态未就绪' }}</a-tag><div v-if="!record.status" class="muted cell-note">{{ record.error || '等待登录或获取种子列表' }}</div></template>
              <template v-if="column.key === 'capacity'"><strong>{{ record.capacity.count }}</strong><div class="muted cell-note">其中待确认 {{ record.capacity.reserved }} · 结果未知 {{ record.capacity.uncertain }}</div></template>
              <template v-if="column.key === 'space'"><strong>{{ bytes(record.capacity.free) }}</strong><div class="muted cell-note">磁盘当前剩余 {{ bytes(record.actualFree) }}</div></template>
              <template v-if="column.key === 'mode'">{{ record.capacity.mode === 'relaxed' ? '宽松' : '严格' }}<div class="muted cell-note">{{ record.spaceGuard ? '用于分流和空间检查' : '空间保护未启用' }}</div></template>
              <template v-if="column.key === 'speed'">↑ {{ bytes(record.uploadSpeed) }}/s<br>↓ {{ bytes(record.downloadSpeed) }}/s</template>
              <template v-if="column.key === 'time'">{{ time(record.updatedAt) }}</template>
            </template>
          </a-table>
        </section>
        <section class="quick-guide"><h2>想做什么？</h2><div class="guide-grid"><button @click="navigate('tasks', 'retries')"><strong>种子为什么没添加？</strong><span>查看失败重试和具体原因</span></button><button @click="navigate('tasks', 'jobs')"><strong>辅种为什么还没启动？</strong><span>查看校验、标签和确认进度</span></button><button @click="section = 'statistics'"><strong>哪些规则有收益？</strong><span>按规则、站点或 RSS 查看数据</span></button><button @click="section = 'delete'"><strong>规则会删掉哪些种子？</strong><span>预览命中结果，不执行删除</span></button></div></section>
        <p class="muted">任务指标基于当前加载的列表：添加与重试各最近 500 项；同一种子可能出现在不同处理阶段，数量不能相加。</p>
      </a-tab-pane>
      <a-tab-pane key="tasks" tab="任务处理">
        <div class="section-heading"><div><h2>查看后台正在做什么</h2><p class="muted">这里是本项目的添加和恢复流程，不是下载器中所有种子的实时下载列表。</p></div></div>
        <a-radio-group v-model:value="taskKind" button-style="solid" class="task-switch" @change="resetTaskFilters"><a-radio-button value="retries">添加失败重试</a-radio-button><a-radio-button value="jobs">添加与辅种确认</a-radio-button><a-radio-button value="waiting">等待已有数据</a-radio-button></a-radio-group>
        <div class="purpose-box"><strong>{{ taskGuide.title }}</strong><p>{{ taskGuide.description }}</p><span class="muted">{{ taskGuide.action }}</span></div>
        <div class="filter-bar"><a-input v-model:value="taskSearch" allow-clear placeholder="搜索种子、RSS、下载器或错误原因" class="search-input" /><a-select v-model:value="taskScope" class="scope-select"><a-select-option value="pending">{{ taskKind === 'waiting' ? '全部等待项' : '待处理' }}</a-select-option><a-select-option value="attention">需要人工关注</a-select-option><a-select-option value="all">全部（含已完成 / 已停止）</a-select-option></a-select><span class="muted">显示 {{ taskRows.length }} 项</span></div>
        <a-table :columns="taskColumns" :data-source="taskRows" row-key="id" size="small" :scroll="{ x: 1100 }" :pagination="{ pageSize: 15, showSizeChanger: true }" :locale="{ emptyText: '当前筛选下没有任务。可切换到全部记录，或清空搜索条件。' }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'"><a @click="openDetail(record)">{{ record.name }}</a><div class="muted cell-note">{{ record.rss }}<span v-if="record.client"> · {{ record.client }}</span></div></template>
            <template v-if="column.key === 'state'"><a-tag :color="stateColor(record)">{{ stateLabel(record) }}</a-tag><div v-if="record.rssEnabled === false" class="muted cell-note">RSS 已停用，自动处理暂停</div></template>
            <template v-if="column.key === 'progress'">{{ taskKind === 'retries' ? '已重试 ' + record.attempts + ' / 5 次' : taskKind === 'jobs' ? '已发送 ' + record.attempts + ' 次添加' : '等待已有完整数据' }}<div v-if="record.mode" class="muted cell-note">{{ modes[record.mode] || record.mode }}</div></template>
            <template v-if="column.key === 'next'">{{ taskKind === 'waiting' ? time(record.expiresAt) : hasNext(record) ? time(record.nextAt) : '—' }}</template>
            <template v-if="column.key === 'error'"><span class="reason-text">{{ record.error || defaultReason(record) }}</span></template>
            <template v-if="column.key === 'actions'"><a-button size="small" @click="openDetail(record)">查看详情 / 处理</a-button></template>
          </template>
        </a-table>
        <p class="muted table-footnote">{{ taskKind === 'waiting' ? '只包含已保留的辅种候选；未设置等待的未命中条目不会出现在这里。' : '每类展示最近 500 项；数量和筛选结果均基于已加载的列表。' }}</p>
      </a-tab-pane>
      <a-tab-pane key="statistics" tab="收益统计">
        <div class="section-heading"><div><h2>这些种子贡献了多少流量？</h2><p class="muted">当前下载器数据与 RSS 历史记录分别展示。种子总大小不是实际磁盘占用，共享文件会重复计入。</p></div></div>
        <a-tabs v-model:activeKey="statisticsKind">
          <a-tab-pane key="rules" tab="按选择规则"><div class="purpose-box"><strong>看哪条选种规则带来了上传</strong><p>流量与种子总大小来自仍在下载器中的已登记种子；已接受任务数来自添加记录。没有规则归属的旧任务归入“默认 / 旧任务”。</p><span class="muted">上传 / 种子大小是贡献比，不是下载器分享率。</span></div><a-table :data-source="data.rules" :columns="ruleColumns" row-key="id" size="small" :scroll="{ x: 950 }"><template #bodyCell="{ column, record }"><template v-if="['upload', 'download', 'size'].includes(column.key)">{{ bytes(record[column.key]) }}</template><template v-if="column.key === 'yield'">{{ ratio(record) }}</template></template></a-table></a-tab-pane>
          <a-tab-pane key="traffic" tab="按站点与下载器"><div class="purpose-box"><strong>比较不同站点在各台机器上的贡献</strong><p>每行代表一个下载器中的一个站点，统计该下载器当前仍存在的种子累计流量。已经删除的种子不计入。</p></div><a-table :data-source="data.traffic" :columns="trafficColumns" row-key="id" size="small" :scroll="{ x: 1000 }"><template #bodyCell="{ column, record }"><template v-if="['upload', 'download', 'size'].includes(column.key)">{{ bytes(record[column.key]) }}</template><template v-if="column.key === 'yield'">{{ ratio(record) }}</template></template></a-table></a-tab-pane>
          <a-tab-pane key="history" tab="RSS 历史汇总"><div class="purpose-box"><strong>查看各 RSS 的历史处理记录</strong><p>来自本地历史表，包含添加、失败和拒绝记录；记录数不等于独立种子数。历史流量以已写入数据库的数据为准，可能与当前下载器统计不同。</p><span class="muted">查看逐条添加及拒绝原因，请进入 RSS 历史页面。</span></div><a-button class="notice" @click="$router.push('/history/rss')">打开 RSS 历史</a-button><a-table :data-source="data.history" :columns="historyColumns" row-key="rss_id" size="small" :scroll="{ x: 800 }"><template #bodyCell="{ column, record }"><template v-if="['upload', 'download'].includes(column.key)">{{ bytes(record[column.key]) }}</template></template></a-table></a-tab-pane>
        </a-tabs>
      </a-tab-pane>
      <a-tab-pane key="events" tab="操作记录">
        <div class="section-heading"><div><h2>追查一次添加或辅种的经过</h2><p class="muted">这里是事件日志，同一种子可能有多条记录。当前状态请看“任务处理”。展示最近 200 条事件。</p></div></div>
        <div class="filter-bar"><a-input v-model:value="eventSearch" allow-clear placeholder="搜索种子、RSS、下载器或原因" class="search-input" /><a-select v-model:value="eventKind" class="scope-select"><a-select-option value="all">全部事件</a-select-option><a-select-option value="errors">失败与拒绝</a-select-option><a-select-option value="retry">自动重试</a-select-option><a-select-option value="reseed">辅种过程</a-select-option><a-select-option value="control">删种 / 暂停 / 限速</a-select-option></a-select><span class="muted">显示 {{ filteredEvents.length }} 条</span></div>
        <a-table :data-source="filteredEvents" :columns="eventColumns" row-key="id" size="small" :scroll="{ x: 1100 }" :pagination="{ pageSize: 20, showSizeChanger: true }" :locale="{ emptyText: '当前筛选下没有事件记录。' }"><template #bodyCell="{ column, record }"><template v-if="column.key === 'time'">{{ time(record.time) }}</template><template v-if="column.key === 'name'">{{ record.name || record.hash || '未命名种子' }}<div class="muted cell-note">{{ record.rss }}<span v-if="record.client"> · {{ record.client }}</span></div></template><template v-if="column.key === 'outcome'"><a-tag :color="errorOutcomes.includes(record.outcome) ? 'error' : 'default'">{{ outcomes[record.outcome] || record.outcome }}</a-tag><div v-if="record.retryAttempt !== undefined" class="muted cell-note">{{ record.retryAttempt ? '第 ' + record.retryAttempt + ' 次重试' : '首次失败' }}</div></template><template v-if="column.key === 'reason'"><span class="reason-text">{{ record.reason || '—' }}</span><div v-if="record.nextAt" class="muted cell-note">当时计划下次处理：{{ time(record.nextAt) }}</div></template></template></a-table>
      </a-tab-pane>
      <a-tab-pane key="delete" tab="删种预览">
        <div class="section-heading"><div><h2>检查删种规则会执行什么</h2><p class="muted">选择下载器，查看命中的规则、拟执行操作及文件保护原因。</p></div></div>
        <a-alert type="info" show-icon message="预览不会删除或暂停种子" description="基于最近一次下载器状态，实际执行前仍会重新检查。自定义 JavaScript 规则应保持无副作用。" class="notice" />
        <div class="filter-bar"><a-select v-model:value="previewClient" placeholder="选择下载器" class="preview-select" @change="resetPreview"><a-select-option v-for="client in data.clients" :key="client.id" :value="client.id">{{ client.alias }}</a-select-option></a-select><a-button type="primary" :loading="previewLoading" :disabled="!previewClient" @click="loadPreview">生成预览</a-button><span v-if="previewLoaded" class="muted">状态时间：{{ time(preview.updatedAt) }}</span></div>
        <a-table v-if="previewLoaded" :data-source="preview.items" :columns="deleteColumns" row-key="hash" size="small" :scroll="{ x: 960 }" :locale="{ emptyText: '该下载器当前没有命中删种规则的种子。' }"><template #bodyCell="{ column, record }"><template v-if="column.key === 'action'">{{ deleteActions[record.action] || record.action }}</template></template></a-table>
        <div v-else class="empty-state"><strong>尚未生成预览</strong><span class="muted">先选择下载器，再点击“生成预览”。</span></div>
      </a-tab-pane>
    </a-tabs>
    <a-drawer v-model:visible="detailVisible" title="任务详情与处理" placement="right" width="min(560px, 100vw)">
      <template v-if="detail">
        <a-tag :color="stateColor(detail)">{{ stateLabel(detail) }}</a-tag><h2 class="detail-name">{{ detail.name }}</h2>
        <a-descriptions :column="1" size="small" bordered><a-descriptions-item label="记录类型">{{ detail.kind === 'retries' ? '添加失败重试' : detail.kind === 'waiting' ? '等待已有数据' : '添加与辅种确认' }}</a-descriptions-item><a-descriptions-item label="RSS 任务">{{ detail.rss }}{{ detail.rssEnabled === false ? '（已停用）' : '' }}</a-descriptions-item><a-descriptions-item v-if="detail.client" label="下载器">{{ detail.client }}</a-descriptions-item><a-descriptions-item v-if="detail.mode" label="添加方式">{{ modes[detail.mode] || detail.mode }}</a-descriptions-item><a-descriptions-item v-if="detail.attempts !== undefined" :label="detail.kind === 'retries' ? '已重试次数' : '已发送添加次数'">{{ detail.attempts }}{{ detail.kind === 'retries' ? ' / 5' : '' }}</a-descriptions-item><a-descriptions-item v-if="hasNext(detail)" label="下次处理">{{ time(detail.nextAt) }}</a-descriptions-item><a-descriptions-item v-if="detail.expiresAt" label="等待截止时间">{{ time(detail.expiresAt) }}</a-descriptions-item><a-descriptions-item label="当前说明">{{ detail.error || defaultReason(detail) }}</a-descriptions-item></a-descriptions>
        <div class="purpose-box"><strong>你可以怎么做？</strong><p>{{ advice(detail) }}</p></div>
        <a-space wrap><a-button v-if="detail.kind === 'jobs' && !['done', 'sending'].includes(detail.state)" type="primary" :loading="acting" @click="confirmAction(detail, detail.state === 'verificationFailed' ? 'recheck' : 'retry')">{{ detail.state === 'verificationFailed' ? '重新校验' : '核实后重试' }}</a-button><a-button v-if="detail.kind === 'jobs' && !['done', 'stopped', 'sending'].includes(detail.state)" danger :disabled="acting" @click="confirmAction(detail, 'stop')">停止自动恢复</a-button><a-button v-if="detail.kind === 'retries' && detail.state === 'waiting'" danger :disabled="acting" @click="confirmAction(detail, 'stopRetry')">停止自动重试</a-button><a-button v-if="detail.kind === 'waiting'" :disabled="acting" @click="confirmAction(detail, 'cancelWait')">移出等待队列</a-button><a-button @click="showEvents(detail)">查看相关日志</a-button></a-space>
      </template>
    </a-drawer>
  </div>
</template>
<script>
import { Modal } from 'ant-design-vue';
import { get, post } from '../../util/axios';
const emptyData = () => ({ clients: [], jobs: [], events: [], retries: [], rules: [], history: [], waiting: [], traffic: [] });
const column = (title, key, width) => ({ title, dataIndex: key, key, width });
export default {
  data () {
    return {
      loading: false,
      loadError: '',
      refreshedAt: null,
      section: 'overview',
      taskKind: 'retries',
      taskScope: 'pending',
      taskSearch: '',
      statisticsKind: 'rules',
      eventSearch: '',
      eventKind: 'all',
      previewClient: undefined,
      previewLoading: false,
      previewLoaded: false,
      preview: { items: [] },
      detailVisible: false,
      detail: null,
      acting: false,
      data: emptyData(),
      modes: { safe: '安全辅种', fast: '快速辅种', compatible: '兼容辅种' },
      retryStates: { waiting: '等待自动重试', done: '添加已接受 / 已确认', exhausted: '重试耗尽，已放弃', stopped: '自动重试已停止' },
      states: { sending: '正在发送请求', accepted: '已接受，等待确认', uncertain: '添加结果待核实', failed: '添加失败，等待处理', verifying: '辅种校验中', verificationFailed: '校验失败，保持暂停', tags: '辅种标签确认中', done: '添加流程完成', stopped: '自动恢复已停止' },
      outcomes: { retryScheduled: '已安排重试', retryStarted: '开始重试', retrySucceeded: '重试成功', retryExhausted: '重试次数耗尽', retryDeferred: '等待核实后重试', retryStopped: '已停止重试', accepted: '添加已接受', reseedAccepted: '辅种已接受', reseedConfirmed: '辅种已确认', reseedMiss: '辅种未命中', reseedError: '辅种错误', rejected: '分配拒绝', failed: '添加失败', uncertain: '添加结果未知', deleted: '已删种', controlled: '已暂停或限速', waitExpired: '等待已过期' },
      errorOutcomes: ['failed', 'uncertain', 'rejected', 'reseedError', 'retryExhausted'],
      deleteActions: { delete: '仅删除任务', deleteFiles: '删除任务及文件', pause: '暂停', limit: '限速' },
      clientColumns: [column('下载器', 'alias', 170), column('状态', 'status', 180), column('下载名额使用', 'capacity', 190), column('可用空间', 'space', 180), column('空间模式', 'mode', 150), column('当前速度', 'speed', 150), column('状态更新时间', 'time', 175)],
      ruleColumns: [column('选择规则', 'alias'), column('已接受任务', 'accepted'), column('已确认辅种', 'reseed'), column('累计上传', 'upload'), column('累计下载', 'download'), column('种子总大小', 'size'), column('上传 / 种子大小', 'yield')],
      historyColumns: [column('RSS 任务', 'alias'), column('历史记录数', 'records'), column('拒绝记录数', 'rejected'), column('历史上传', 'upload'), column('历史下载', 'download')],
      trafficColumns: [column('下载器', 'client'), column('站点', 'tracker'), column('当前种子数', 'count'), column('累计上传', 'upload'), column('累计下载', 'download'), column('种子总大小', 'size'), column('上传 / 种子大小', 'yield')],
      eventColumns: [column('发生时间', 'time', 175), column('种子与来源', 'name', 350), column('发生了什么', 'outcome', 185), column('原因与处理计划', 'reason', 390)],
      deleteColumns: [column('种子', 'name', 330), column('命中规则', 'rule', 190), column('拟执行操作', 'action', 150), column('文件保护原因', 'protectedBy', 290)]
    };
  },
  computed: {
    summaryCards () {
      return [
        { key: 'clients', title: '下载器状态正常', value: this.data.clients.filter(c => c.status).length + ' / ' + this.data.clients.length, description: '查看状态、名额与可用空间', section: 'overview', warning: this.data.clients.some(c => !c.status) },
        { key: 'retries', title: '等待添加重试', value: this.data.retries.filter(r => r.state === 'waiting').length, description: '添加失败，等待再次尝试', section: 'tasks', kind: 'retries' },
        { key: 'jobs', title: '添加流程待处理', value: this.data.jobs.filter(job => !['done', 'stopped'].includes(job.state)).length, description: '核实结果、校验或补标签', section: 'tasks', kind: 'jobs' },
        { key: 'waiting', title: '等待已有完整数据', value: this.data.waiting.length, description: '仅辅种候选，等待源种完成', section: 'tasks', kind: 'waiting' }
      ];
    },
    attentionItems () {
      return [
        ...this.data.clients.filter(c => !c.status).map(c => ({ key: 'client:' + c.id, label: '状态未就绪', name: c.alias, reason: c.error || '等待登录或获取种子列表', client: c })),
        ...this.data.retries.filter(r => r.state === 'exhausted').map(r => ({ key: 'retry:' + r.id, label: '重试耗尽', name: r.name, reason: r.error, record: { ...r, kind: 'retries' } })),
        ...this.data.jobs.filter(j => j.state === 'verificationFailed').map(j => ({ key: 'job:' + j.id, label: '校验失败', name: j.name, reason: j.error, record: { ...j, kind: 'jobs' } }))
      ];
    },
    taskGuide () {
      return {
        retries: { title: '添加请求失败后，系统是否还在尝试？', description: '只记录发生过失败并进入重试队列的 RSS 种子。每 30 秒重试一次，最多重试 5 次；离开 RSS 列表后仍可继续处理。', action: '通常等待自动处理即可。重试耗尽时查看错误并修正配置；存在对应添加记录时，可到“添加与辅种确认”核实后重试。' },
        jobs: { title: '添加请求被接受后，流程是否真正完成？', description: '记录已登记的添加请求，包含普通下载和辅种。辅种还需校验及确认 Reseed / Brseed 标签。与“失败重试”是同一流程的不同阶段，数量不能相加。', action: '校验中通常无需操作；结果未知时先核实。校验失败保持暂停，请确认文件后再校验。“流程完成”不代表普通种子已经下载完成。' },
        waiting: { title: '为什么还没有添加辅种？', description: '仅辅种暂时未找到可复用的完整数据时，把候选保留在这里，等待源种完成后再匹配。不是添加失败，也不会转为普通下载。', action: '等待源数据完成，或移出不需要的候选。移出后，条目仍在 RSS 中时可能再次进入队列。' }
      }[this.taskKind];
    },
    taskRows () {
      return this.data[this.taskKind].map(record => ({ ...record, kind: this.taskKind })).filter(record => {
        const pending = record.kind === 'waiting' || (record.kind === 'retries' ? record.state === 'waiting' : !['done', 'stopped'].includes(record.state));
        const attention = record.kind === 'retries' ? record.state === 'exhausted' : record.kind === 'jobs' && ['verificationFailed', 'uncertain', 'failed'].includes(record.state);
        return (this.taskScope === 'all' || (this.taskScope === 'attention' ? attention : pending)) && this.matches(record, this.taskSearch);
      });
    },
    taskColumns () { return [column('种子与来源', 'name', 330), column('当前状态', 'state', 180), column('处理进度', 'progress', 170), column(this.taskKind === 'waiting' ? '等待截止' : '下次处理', 'next', 180), column('当前说明', 'error', 300), column('操作', 'actions', 150)]; },
    filteredEvents () {
      return this.data.events.filter(event => {
        const category = this.eventKind === 'all' || (this.eventKind === 'errors' ? this.errorOutcomes.includes(event.outcome) : this.eventKind === 'retry' ? event.outcome.startsWith('retry') : this.eventKind === 'reseed' ? ['reseedAccepted', 'reseedConfirmed', 'reseedMiss', 'reseedError', 'waitExpired'].includes(event.outcome) : ['deleted', 'controlled'].includes(event.outcome));
        return category && this.matches({ ...event, error: event.reason }, this.eventSearch);
      });
    }
  },
  methods: {
    bytes (value) { return value !== null && value !== undefined && Number.isFinite(Number(value)) ? this.$formatSize(Number(value)) : '未知'; },
    time (value) { return value ? new Date(value).toLocaleString() : '—'; },
    ratio (record) { return record.size ? (record.upload / record.size).toFixed(2) : '—'; },
    matches (record, search) { return [record.name, record.hash, record.rss, record.client, record.error, this.stateLabel(record)].join(' ').toLowerCase().includes(search.trim().toLowerCase()); },
    stateLabel (record) { return record.kind === 'waiting' ? '等待完整数据' : record.kind === 'retries' ? this.retryStates[record.state] || record.state : this.states[record.state] || record.state; },
    stateColor (record) { return ['exhausted', 'verificationFailed'].includes(record.state) ? 'error' : ['uncertain', 'failed'].includes(record.state) ? 'warning' : record.state === 'done' ? 'success' : record.state === 'stopped' ? 'default' : 'processing'; },
    hasNext (record) { return record.kind === 'retries' ? record.state === 'waiting' : record.kind === 'jobs' && !['done', 'stopped', 'verificationFailed'].includes(record.state); },
    defaultReason (record) {
      if (record.kind === 'waiting') return '等待找到可复用的完整数据，不执行普通下载';
      if (record.state === 'done') return record.kind === 'jobs' ? '添加流程结束，下载进度请在下载器查看' : '添加请求已接受或种子已确认存在';
      return record.state === 'sending' ? '请求正在发送，请等待' : record.state === 'verifying' ? '正在校验已有文件，通过后继续辅种流程' : record.state === 'tags' ? '正在确认辅种标签' : '等待后台下一轮处理';
    },
    advice (record) {
      if (record.kind === 'waiting') return '确认来源下载器有对应文件，等待原种完成。移出队列只取消本次保留，不删除种子或文件。';
      if (record.kind === 'retries') return record.state === 'waiting' ? '系统会自动核实并重试。停止重试不撤回已发出的请求，也不删除下载器中的种子。' : '查看错误及相关日志。修正原因后，若存在对应的添加记录，可到“添加与辅种确认”核实后重试；该列表本身没有重新启动操作。';
      return record.state === 'verificationFailed' ? '先检查源文件和保存路径。重新校验会先暂停目标种子；通过后才继续辅种。' : record.state === 'done' ? '添加流程已结束，无需重试。普通种子的实际下载进度请到下载器查看。' : '核实后重试会实时查询原下载器，已存在则继续确认；不存在才允许后续添加。刚发出的请求可能需等待至少两分钟。停止恢复不会撤回请求或直接释放未知预占。';
    },
    resetTaskFilters () { this.taskScope = 'pending'; this.taskSearch = ''; },
    navigate (section, kind) { this.section = section; if (kind) { this.taskKind = kind; this.resetTaskFilters(); } },
    openDetail (record) { this.detail = { ...record }; this.detailVisible = true; },
    inspectAttention (item) { if (item.record) this.openDetail(item.record); else this.$router.push('/base/downloader'); },
    showEvents (record) { this.detailVisible = false; this.eventSearch = record.name || record.hash || ''; this.eventKind = 'all'; this.section = 'events'; },
    async refresh () {
      this.loading = true;
      try {
        this.data = { ...emptyData(), ...(await get('/api/brush/overview')).data };
        this.refreshedAt = Date.now();
        this.loadError = '';
        if (this.detail) { const updated = this.data[this.detail.kind].find(row => row.id === this.detail.id); if (updated) this.detail = { ...updated, kind: this.detail.kind }; else this.detailVisible = false; }
      } catch (error) { this.loadError = error.message; } finally { this.loading = false; }
    },
    confirmAction (record, operation) {
      const prompts = { retry: ['核实原下载器并重试？', '先查询原下载器，避免重复添加；不存在时重置重试机会。当前 RSS 规则仍然生效。'], recheck: ['重新校验辅种文件？', '目标种子会先暂停，然后重新校验；通过后才继续标签与启动流程。'], stop: ['停止自动恢复？', '不撤回已发出的请求，不删除种子或文件，也不直接释放未知请求的预占。'], stopRetry: ['停止自动重试？', '取消后续自动尝试，不撤回已经发送的添加请求。'], cancelWait: ['移出辅种等待队列？', '取消保留候选；如果仍在 RSS 中，后续匹配时可能再次进入。'] };
      Modal.confirm({ title: prompts[operation][0], content: prompts[operation][1], okText: '确认', cancelText: '取消', onOk: () => this.action(record.id, operation) });
    },
    async action (id, operation) {
      this.acting = true;
      try { await post('/api/brush/action', { id, operation }); this.$message().success('操作完成'); await this.refresh(); } catch (error) { this.$message().error(error.message); throw error; } finally { this.acting = false; }
    },
    resetPreview () { this.preview = { items: [] }; this.previewLoaded = false; },
    async loadPreview () {
      const clientId = this.previewClient;
      this.previewLoading = true;
      try { const result = (await get('/api/brush/deletePreview?clientId=' + encodeURIComponent(clientId))).data; if (clientId === this.previewClient) { this.preview = result; this.previewLoaded = true; } } catch (error) { if (clientId === this.previewClient) this.resetPreview(); this.$message().error(error.message); } finally { this.previewLoading = false; }
    }
  },
  mounted () { this.refresh(); }
};
</script>
<style scoped>
.brush-center { max-width: 1600px; margin: 0 auto; }
h1, h2, p { margin: 0; }
h1 { font-size: 26px; font-weight: 650; }
h2 { font-size: 18px; font-weight: 600; }
.muted { opacity: .65; font-size: 13px; }
.page-header, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.page-header p, .section-heading p { margin-top: 6px; }
.notice { margin-bottom: 16px; }
.summary-grid, .guide-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 24px; }
.summary-card, .guide-grid button, .attention-item { color: inherit; background: transparent; border: 1px solid rgba(128, 128, 128, .22); border-radius: 10px; text-align: left; cursor: pointer; transition: border-color .2s, background .2s; }
.summary-card:hover, .guide-grid button:hover, .attention-item:hover { border-color: #1890ff; background: rgba(24, 144, 255, .04); }
.summary-card:focus-visible, .guide-grid button:focus-visible, .attention-item:focus-visible { outline: 2px solid #1890ff; outline-offset: 2px; }
.summary-card { padding: 20px; display: flex; flex-direction: column; gap: 12px; }
.summary-card strong { font-size: 30px; line-height: 1.2; }
.warning { color: #d97706; }
.panel { border: 1px solid rgba(128, 128, 128, .18); border-radius: 12px; padding: 20px; margin-bottom: 24px; }
.attention-list { display: flex; flex-direction: column; gap: 8px; }
.attention-item { display: flex; align-items: center; gap: 10px; padding: 12px; width: 100%; }
.attention-copy { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.attention-copy strong, .attention-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty-state { padding: 36px 16px; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
.quick-guide h2 { margin-bottom: 14px; }
.guide-grid button { padding: 18px; display: flex; flex-direction: column; gap: 8px; }
.guide-grid span { font-size: 13px; opacity: .65; }
.purpose-box { padding: 16px 18px; border-left: 3px solid #1890ff; background: rgba(24, 144, 255, .05); margin: 16px 0 20px; border-radius: 0 8px 8px 0; }
.purpose-box p { margin: 6px 0; line-height: 1.8; }
.filter-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.search-input { width: 360px; max-width: 100%; }
.scope-select { width: 220px; }
.preview-select { width: 260px; }
.cell-note { margin-top: 5px; line-height: 1.5; overflow-wrap: anywhere; }
.reason-text { overflow-wrap: anywhere; white-space: pre-wrap; }
.table-footnote { margin-top: 12px; }
.detail-name { margin: 14px 0 20px; overflow-wrap: anywhere; }
@media (max-width: 900px) { .summary-grid, .guide-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .page-header, .section-heading { align-items: flex-start; flex-direction: column; } }
@media (max-width: 540px) { .summary-grid, .guide-grid { grid-template-columns: 1fr; } .summary-card { padding: 16px; } .panel { padding: 12px; } .search-input, .scope-select { width: 100%; } .task-switch { display: flex; flex-wrap: wrap; gap: 6px; } }
</style>
