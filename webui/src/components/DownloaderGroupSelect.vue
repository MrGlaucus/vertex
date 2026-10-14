<template>
  <div>
    <responsive-multi-select :value="value" :options="options" placeholder="选择已维护的下载器组" title="选择下载器组"
      @update:value="$emit('update:value', $event)" @open="$emit('refresh')" />
    <div v-for="id in value || []" :key="id" class="group-preview">
      {{ groupName(id) }}：{{ members(id) || '没有可用成员' }}
    </div>
    <div v-if="missing.length" class="group-error">组引用已失效，请重新选择；不会回退到其他下载器。</div>
    <div class="group-help">与单独选择的下载器合并去重；成员变更自动生效。<router-link to="/base/downloader-group">维护下载器组</router-link></div>
  </div>
</template>
<script>
import ResponsiveMultiSelect from './ResponsiveMultiSelect';
export default {
  components: { ResponsiveMultiSelect },
  props: {
    value: { type: Array, default: () => [] },
    groups: { type: Array, default: () => [] },
    reseed: Boolean
  },
  emits: ['update:value', 'refresh'],
  computed: {
    options () { return this.groups.map(group => ({ value: group.id, label: group.alias, description: `${group.clientIds.length} 台 · ${this.members(group.id) || '没有可用成员'}` })); },
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
.group-preview, .group-help { margin-top: 6px; font-size: 12px; opacity: .75; overflow-wrap: anywhere; }
.group-error { color: #ff4d4f; margin-top: 6px; }
</style>
