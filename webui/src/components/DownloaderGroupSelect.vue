<template>
  <div>
    <a-select mode="multiple" :value="value || []" placeholder="选择已维护的下载器组" style="width: 100%;" allow-clear option-filter-prop="label"
      @update:value="$emit('update:value', $event)" @dropdownVisibleChange="open => open && $emit('refresh')">
      <a-select-option v-for="group in groups" :key="group.id" :value="group.id" :label="group.alias">{{ group.alias }}（{{ group.clientIds.length }} 台）</a-select-option>
      <a-select-option v-for="id in missing" :key="id" :value="id" :label="id">已失效的组：{{ id }}</a-select-option>
    </a-select>
    <div v-for="id in value || []" :key="id" class="group-preview">
      {{ groupName(id) }}：{{ members(id) || '没有可用成员' }}
    </div>
    <div v-if="missing.length" class="group-error">组引用已失效，请重新选择；不会回退到其他下载器。</div>
    <div class="group-help">与单独选择的下载器合并去重；成员变更自动生效。<router-link to="/base/downloader-group">维护下载器组</router-link></div>
  </div>
</template>
<script>
export default {
  props: {
    value: { type: Array, default: () => [] },
    groups: { type: Array, default: () => [] },
    reseed: Boolean
  },
  emits: ['update:value', 'refresh'],
  computed: {
    missing () { return (this.value || []).filter(id => !this.groups.some(group => group.id === id)); }
  },
  methods: {
    groupName (id) { return this.groups.find(group => group.id === id)?.alias || id; },
    members (id) {
      return (this.groups.find(group => group.id === id)?.members || []).map(member => member.alias + (member.missing ? '（已删除）' : !member.enable ? '（未启用）' : this.reseed && member.type !== 'qBittorrent' ? '（不支持辅种）' : '')).join('、');
    }
  }
};
</script>
<style scoped>
.group-preview, .group-help { margin-top: 6px; font-size: 12px; opacity: .75; }
.group-error { color: #ff4d4f; margin-top: 6px; }
</style>
