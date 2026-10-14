<template>
  <div style="font-size: 24px; font-weight: bold;">下载器组</div>
  <a-divider />
  <div class="groups-page">
    <a-alert type="info" show-icon message="一次维护，多处引用" description="在这里维护成员，再在 RSS 任务、辅种下载器和 RSS 规则中引用组。保存后所有引用自动使用最新成员，无需重启；已经添加的种子继续运行。" />
    <a-table :data-source="groups" :columns="columns" row-key="id" size="small" :scroll="{ x: 760 }" :pagination="false" style="margin-top: 20px;">
      <template #title><a @click="load">刷新列表</a></template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'members'">
          <a-tag v-for="member in record.members" :key="member.id" :color="member.missing ? 'error' : member.enable ? 'default' : 'warning'">{{ member.alias }}{{ member.missing ? '（已删除）' : !member.enable ? '（未启用）' : '' }}</a-tag>
          <span v-if="!record.clientIds.length">空组 · 不提供候选下载器</span>
        </template>
        <template v-if="column.key === 'references'">
          <div v-for="reference in record.references" :key="reference">{{ reference }}</div>
          <span v-if="!record.references.length">暂无引用</span>
        </template>
        <template v-if="column.key === 'actions'">
          <a @click="edit(record)">编辑</a><a-divider type="vertical" />
          <a-popover v-if="!record.references.length" title="删除这个下载器组？" trigger="click"><template #content><a-button danger size="small" @click="remove(record)">确认删除</a-button></template><a style="color: #ff4d4f;">删除</a></a-popover>
          <span v-else style="opacity: .5;">被引用</span>
        </template>
      </template>
    </a-table>
    <a-divider />
    <h3>{{ group.id ? '编辑下载器组' : '新增下载器组' }}</h3>
    <a-form :model="group" layout="vertical" @finish="save">
      <a-form-item label="组名称" name="alias" :rules="[{ required: true, whitespace: true, message: '请输入组名称' }]"><a-input v-model:value="group.alias" :maxlength="80" placeholder="例如：大容量 HDD、日常刷流、辅种机器" /></a-form-item>
      <a-form-item label="组成员" name="clientIds" extra="可以保留空组。未启用或离线下载器不会参与实际分配；辅种只使用 qBittorrent。">
        <responsive-multi-select v-model:value="group.clientIds" :options="clientOptions" placeholder="选择下载器" title="选择组成员" />
      </a-form-item>
      <a-form-item><a-space><a-button type="primary" html-type="submit" :loading="saving">保存下载器组</a-button><a-button @click="clear">清空</a-button></a-space></a-form-item>
    </a-form>
  </div>
</template>
<script>
import ResponsiveMultiSelect from '@/components/ResponsiveMultiSelect';
export default {
  components: { ResponsiveMultiSelect },
  data () {
    return {
      groups: [],
      clients: [],
      group: { alias: '', clientIds: [] },
      saving: false,
      columns: [{ title: '组名称', dataIndex: 'alias', width: 170 }, { title: '当前成员', key: 'members', width: 320 }, { title: '引用位置', key: 'references', width: 300 }, { title: '操作', key: 'actions', width: 120 }]
    };
  },
  computed: {
    clientOptions () { return this.clients.map(client => ({ value: client.id, label: client.alias, description: client.type + (client.enable ? '' : '（未启用）') })); }
  },
  methods: {
    async load () {
      try {
        const [groups, clients] = await Promise.all([this.$api().downloaderGroup.list(), this.$api().downloader.list()]);
        this.groups = groups.data.sort((a, b) => a.alias.localeCompare(b.alias));
        this.clients = clients.data.sort((a, b) => a.alias.localeCompare(b.alias));
      } catch (error) { this.$message().error(error.message); }
    },
    edit (group) { this.group = { id: group.id, alias: group.alias, clientIds: [...group.clientIds] }; },
    clear () { this.group = { alias: '', clientIds: [] }; },
    async save () {
      this.saving = true;
      try {
        const result = await this.$api().downloaderGroup.save(this.group);
        this.$message().success(result.message);
        this.clear();
        await this.load();
      } catch (error) { this.$message().error(error.message); } finally { this.saving = false; }
    },
    async remove (group) {
      try {
        await this.$api().downloaderGroup.delete(group.id);
        if (this.group.id === group.id) this.clear();
        await this.load();
        this.$message().success('下载器组已删除');
      } catch (error) { this.$message().error(error.message); }
    }
  },
  mounted () { this.load(); }
};
</script>
<style scoped>
.groups-page { max-width: 1440px; margin: 0 auto; }
.ant-tag { margin-bottom: 4px; }
</style>
