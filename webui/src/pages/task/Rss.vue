<template>
  <div style="font-size: 24px; font-weight: bold;">RSS 任务</div>
  <a-divider></a-divider>
  <div class="rss">
    <a-table
      :style="`font-size: ${isMobile() ? '12px': '14px'};`"
      :columns="columns"
      size="small"
      :data-source="rssList"
      :pagination="false"
      :scroll="{ x: 640 }"
    >
      <template #title>
        <span style="font-size: 16px; font-weight: bold;">RSS 任务列表</span>
        <a style="margin-left: 16px;" @click="listRss()">刷新状态</a>
      </template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.dataIndex === 'enable'">
          <a-switch @change="enableTask(record)" v-model:checked="record.enable" checked-children="启用" un-checked-children="禁用"/>
        </template>
        <template v-if="column.dataIndex === 'scheduleState'">
          <a-tag :color="scheduleColor(record)">{{ scheduleLabel(record) }}</a-tag>
          <div v-if="record.scheduleState?.nextAt">下次时段：{{ record.scheduleState.nextAt }}</div>
          <div v-if="record.dailyWindowEnabled">每日 {{ record.windowStart }} 至{{ record.windowStart > record.windowEnd ? '次日 ' : ' ' }}{{ record.windowEnd }}</div>
          <div v-if="record.scheduleState?.expiresAt">截止：{{ record.scheduleState.expiresAt }}</div>
          <div v-if="record.scheduleState?.status === 'outside' && !record.scheduleState?.nextAt">截止前无可运行时段</div>
        </template>
        <template v-if="column.dataIndex === 'clientArr'">
          {{ downloaderNames(record) }}
          <div v-if="record.clientGroupIds?.length" style="font-size: 12px; opacity: .7;">引用组：{{ groupNames(record.clientGroupIds) }}</div>
          <div v-if="record.reseedGroupIds?.length" style="font-size: 12px; opacity: .7;">辅种组：{{ groupNames(record.reseedGroupIds) }}</div>
        </template>
        <template v-if="column.dataIndex === 'pushNotify'">
          <a-tag color="success" v-if="record.pushNotify">启用</a-tag>
          <a-tag color="error" v-if="!record.pushNotify">禁用</a-tag>
        </template>
        <template v-if="column.title === '操作'">
          <span>
            <a @click="modifyClick(record)">编辑</a>
            <a-divider type="vertical" />
            <a @click="cloneClick(record)">克隆</a>
            <a-divider type="vertical" />
            <a-popover title="删除?" trigger="click" :overlayStyle="{ width: '84px', overflow: 'hidden' }">
              <template #content>
                <a-button type="primary" danger @click="deleteRss(record)" size="small">删除</a-button>
              </template>
              <a style="color: red">删除</a>
            </a-popover>
          </span>
        </template>
      </template>
    </a-table>
    <a-divider></a-divider>
    <div style="font-size: 16px; font-weight: bold; padding-left: 8px;">新增 | 编辑RSS 任务</div>
    <div style="text-align: left; ">
      <a-form
        labelAlign="right"
        :labelWrap="true"
        :model="rss"
        size="small"
        @finish="modifyRss"
        :labelCol="{ span: 3 }"
        :wrapperCol="{ span: 21 }"
        autocomplete="off"
        :class="`container-form-${ isMobile() ? 'mobile' : 'pc' }`">
        <a-form-item
          label="别名"
          name="alias"
          extra="给 RSS 任务取一个好记的名字"
          :rules="[{ required: true, message: '${label}不可为空! ' }]">
          <a-input size="small" v-model:value="rss.alias"/>
        </a-form-item>
        <a-form-item
          label="启用"
          name="enable"
          extra="选择是否启用 RSS 任务"
          :rules="[{ required: true, message: '${label}不可为空! ' }]">
          <a-checkbox v-model:checked="rss.enable">启用</a-checkbox>
        </a-form-item>
        <a-form-item label="定时运行" extra="时间按服务端时区计算，与浏览器时区无关。时段内仍按 RSS Cron 抓取；时段外暂停抓取、添加重试和等待辅种，已添加种子继续运行。">
          <div>服务端时区：{{ rssList[0]?.scheduleState?.timezone || '容器 TZ 设置' }}（TZ=Asia/Shanghai 时为北京时间）</div>
          <a-checkbox v-model:checked="rss.dailyWindowEnabled">每日运行时段</a-checkbox>
          <div v-if="rss.dailyWindowEnabled" class="schedule-inputs">
            <a-form-item name="windowStart" :rules="[{ required: true, message: '请选择开始时间' }]">
              <a-input type="time" v-model:value="rss.windowStart" aria-label="每日开始时间" />
            </a-form-item>
            <span>至{{ rss.windowStart > rss.windowEnd ? '次日' : '' }}</span>
            <a-form-item name="windowEnd" :rules="[{ required: true, message: '请选择结束时间' }]">
              <a-input type="time" v-model:value="rss.windowEnd" aria-label="每日结束时间" />
            </a-form-item>
          </div>
          <div class="schedule-expiry">
            <a-checkbox v-model:checked="rss.expireEnabled">到期自动关闭</a-checkbox>
            <a-form-item v-if="rss.expireEnabled" name="expireAt" :rules="[{ required: true, message: '请选择自动关闭时间' }]">
              <a-input type="datetime-local" v-model:value="rss.expireAt" aria-label="自动关闭时间" style="max-width: 280px;" />
            </a-form-item>
          </div>
          <div v-if="rss.expireEnabled" class="regex-help">到期后自动取消启用并保存，取消未执行的重试和等待辅种；已经发送的添加请求继续确认结果。重新启用前需修改或清除截止时间。</div>
        </a-form-item>
        <a-form-item
          label="下载器"
          name="clientArr"
          extra="可以单独选择下载器，也可以仅引用下方的下载器组。"
          :rules="[{ validator: validateDownloaders }]">
          <a-checkbox-group style="width: 100%;" v-model:value="rss.clientArr">
            <a-row>
              <a-col v-for="downloader of downloaders" :span="8" :key="downloader.id">
                <a-checkbox :disabled="!downloader.enable && !(rss.clientArr || []).includes(downloader.id)" v-model:value="downloader.id">{{ downloader.alias }}</a-checkbox>
              </a-col>
            </a-row>
          </a-checkbox-group>
        </a-form-item>
        <a-form-item label="引用下载器组" name="clientGroupIds" extra="作为这个 RSS 任务的普通下载器范围。规则同样引用组时，只在两者交集内分配。">
          <downloader-group-select v-model:value="rss.clientGroupIds" :groups="downloaderGroups" @refresh="listGroups" />
        </a-form-item>
        <a-form-item
          label="排序规则"
          name="clientSortBy"
          extra="按剩余空间排序时，已启用空间保护的下载器使用其严格或宽松模式计算值；未启用时使用当前磁盘剩余空间。"
          :rules="[{ required: true, message: '${label}不可为空! ' }]">
          <a-select size="small" v-model:value="rss.clientSortBy">
            <a-select-option value="leechingCount">下载种子数量</a-select-option>
            <a-select-option value="uploadSpeed">当前上传速度</a-select-option>
            <a-select-option value="downloadSpeed">当前下载速度</a-select-option>
            <a-select-option value="freeSpaceOnDisk">当前剩余空间</a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item
          label="下载器最高上传速度"
          name="maxClientUploadSpeed"
          extra="下载器上传速度在此速度之上时, 不添加种子, 留空或 0 不启用">
          <a-input size="small" v-model:value="rss.maxClientUploadSpeed">
            <template #addonAfter>
              <a-select size="small" v-model:value="rss.maxClientUploadSpeedUnit" placeholder="选择单位" style="width: 120px">
                <a-select-option value="KiB">KiB/s</a-select-option>
                <a-select-option value="MiB">MiB/s</a-select-option>
                <a-select-option value="GiB">GiB/s</a-select-option>
              </a-select>
            </template>
          </a-input>
        </a-form-item>
        <a-form-item
          label="下载器最高下载速度"
          name="maxClientDownloadSpeed"
          extra="下载器下载速度在此速度之上时, 不添加种子, 留空或 0 不启用">
          <a-input size="small" v-model:value="rss.maxClientDownloadSpeed">
            <template #addonAfter>
              <a-select size="small" v-model:value="rss.maxClientDownloadSpeedUnit" placeholder="选择单位" style="width: 120px">
                <a-select-option value="KiB">KiB/s</a-select-option>
                <a-select-option value="MiB">MiB/s</a-select-option>
                <a-select-option value="GiB">GiB/s</a-select-option>
              </a-select>
            </template>
          </a-input>
        </a-form-item>
        <a-form-item
          label="下载器下载任务上限"
          name="maxClientDownloadCount"
          extra="下载器下载任务之上时, 不添加种子, 留空或 0 不启用">
          <a-input size="small" v-model:value="rss.maxClientDownloadCount">
          </a-input>
        </a-form-item>
        <a-form-item
          label="RssUrl 列表"
          name="rssUrls"
          :rules="[{ required: true, message: '${label}不可为空! ' }]">
          <a-form-item-rest v-for="(item, index) in rss.rssUrls" :key="index">
            <a-input-group compact>
              <a-input size="small" v-model:value="rss.rssUrls[index]" style="width: calc(100% - 64px)"/>
              <a-button
                type="danger"
                size="small" @click="() => rss.rssUrls = rss.rssUrls.filter(i => i !== rss.rssUrls[index])"
                style="width: 64px;">删除</a-button>
            </a-input-group>
          </a-form-item-rest>
          <a-button
            size="small"
            type="primary"
            @click="rss.rssUrls.push('')"
            >
            新增
          </a-button>
        </a-form-item>
        <a-form-item
          label="抓取免费"
          name="scrapeFree"
          :rules="[{ required: true, message: '${label}不可为空! ' }]">
          <a-checkbox v-model:checked="rss.scrapeFree">抓取免费</a-checkbox>
        </a-form-item>
        <a-form-item
          label="排除 HR"
          name="scrapeHr"
          :rules="[{ required: true, message: '${label}不可为空! ' }]">
          <a-checkbox v-model:checked="rss.scrapeHr">排除 HR</a-checkbox>
        </a-form-item>
        <a-form-item
          label="Cookie"
          v-if="rss.scrapeHr || rss.scrapeFree"
          name="cookie"
          extra="Cookie, M-Team 为 api key"
          :rules="[{ required: true, message: '${label}不可为空! ' }]">
          <a-input size="small" v-model:value="rss.cookie"/>
        </a-form-item>
        <a-form-item
          label="Rss 周期"
          name="cron"
          extra="Rss Cron 表达式, 默认为 1 分钟更新一次"
          :rules="[{ required: true, message: '${label}不可为空! ' }]">
          <a-input size="small" v-model:value="rss.cron"/>
        </a-form-item>
        <a-form-item
          label="推送通知"
          name="pushNotify"
          :rules="[{ required: true, message: '${label}不可为空! ' }]">
          <a-checkbox v-model:checked="rss.pushNotify">启用</a-checkbox>
        </a-form-item>
        <a-form-item
          v-if="rss.pushNotify"
          label="通知方式"
          name="notify"
          extra="通知方式, 用于推送删种等信息, 在通知工具页面创建"
          :rules="[{ required: true, message: '${label}不可为空! ' }]">
          <a-select size="small" v-model:value="rss.notify">
            <a-select-option v-for="notification of notifications" v-model:value="notification.id" :key="notification.id">{{ notification.alias }}</a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item
          label="限制上传速度"
          name="uploadLimit"
          extra="限制种子的上传速度, 0 为不限速"
          :rules="[{ required: true, message: '${label}不可为空! ' }]">
          <a-input size="small" v-model:value="rss.uploadLimit">
            <template #addonAfter>
              <a-select size="small" v-model:value="rss.uploadLimitUnit" placeholder="选择单位" style="width: 120px">
                <a-select-option value="KiB">KiB/s</a-select-option>
                <a-select-option value="MiB">MiB/s</a-select-option>
                <a-select-option value="GiB">GiB/s</a-select-option>
              </a-select>
            </template>
          </a-input>
        </a-form-item>
        <a-form-item
          label="限制下载速度"
          name="downloadLimit"
          extra="限制种子的下载速度, 0 为不限速"
          :rules="[{ required: true, message: '${label}不可为空! ' }]">
          <a-input size="small" v-model:value="rss.downloadLimit">
            <template #addonAfter>
              <a-select size="small" v-model:value="rss.downloadLimitUnit" placeholder="选择单位" style="width: 120px">
                <a-select-option value="KiB">KiB/s</a-select-option>
                <a-select-option value="MiB">MiB/s</a-select-option>
                <a-select-option value="GiB">GiB/s</a-select-option>
              </a-select>
            </template>
          </a-input>
        </a-form-item>
        <a-form-item
          label="保存路径"
          name="savePath"
          extra="推送种子至下载器时的保存路径">
          <a-input size="small" v-model:value="rss.savePath"/>
        </a-form-item>
        <a-form-item
          label="分类"
          name="category"
          extra="推送种子至下载器时的分类">
          <a-input size="small" v-model:value="rss.category"/>
        </a-form-item>
        <a-form-item
          label="每小时上限"
          name="addCountPerHour"
          extra="每小时向客户端推送种子数量上限, 留空为 20, 编辑 Rss 或重启后重置计数">
          <a-input size="small" v-model:value="rss.addCountPerHour"/>
        </a-form-item>
        <a-form-item
          label="添加种子时暂停"
          name="paused"
          extra="向下载器添加种子时暂停种子">
          <a-checkbox v-model:checked="rss.paused">添加种子时暂停</a-checkbox>
        </a-form-item>
        <a-form-item
          label="自动管理"
          name="autoTMM"
          extra="向下载器添加种子时启用种子的自动管理功能, 不了解请勿勾选">
          <a-checkbox v-model:checked="rss.autoTMM">自动管理</a-checkbox>
        </a-form-item>
        <a-form-item
          label="等待时间"
          name="sleepTime"
          extra="若在 Rss 时种子是非免费状态, 将在种子发布后的一段时间内重复抓取免费状态, 建议等待时间略小于 Rss 周期">
          <a-input size="small" v-model:value="rss.sleepTime"/>
        </a-form-item>
        <a-form-item
          label="最长休眠时间"
          name="maxSleepTime"
          extra="距上次成功获取超过此秒数，恢复时跳过本轮新候选；建议设为 RSS 周期的 3–5 倍。正常重启后的首次成功获取不触发，获取失败不刷新成功时间，重试任务不受此限制。"
          :rules="[{ required: true, message: '${label}不可为空! ' }]">
          <a-input size="small" v-model:value="rss.maxSleepTime"/>
        </a-form-item>
        <a-form-item label="自动辅种" name="autoReseed" extra="优先在持有完整数据的 qBittorrent 上添加，普通下载容量限制不会拦截辅种。">
          <a-checkbox v-model:checked="rss.autoReseed">启用自动辅种</a-checkbox>
        </a-form-item>
        <a-form-item label="仅辅种" name="onlyReseed" extra="没有匹配到已有完整数据时不进行普通下载。">
          <a-checkbox v-model:checked="rss.onlyReseed">仅辅种</a-checkbox>
        </a-form-item>
        <a-form-item v-if="rss.autoReseed || rss.onlyReseed" label="辅种下载器" name="reseedClients">
          <a-select mode="multiple" v-model:value="rss.reseedClients"><a-select-option v-for="client of downloaders.filter(c => c.type === 'qBittorrent')" :key="client.id" :value="client.id">{{ client.alias }}</a-select-option></a-select>
        </a-form-item>
        <a-form-item v-if="rss.autoReseed || rss.onlyReseed" label="引用辅种下载器组" name="reseedGroupIds" extra="组内仅启用且可用的 qBittorrent 参与辅种；可以只选择组，不必逐个选择下载器。">
          <downloader-group-select v-model:value="rss.reseedGroupIds" :groups="downloaderGroups" reseed @refresh="listGroups" />
        </a-form-item>
        <a-form-item v-if="rss.autoReseed || rss.onlyReseed" label="辅种策略" name="reseedMode" extra="安全和兼容模式暂停添加后执行校验；校验失败保持暂停，不自动补下载。快速模式仅用于已确认一致的跨站资源。">
          <a-select v-model:value="rss.reseedMode">
            <a-select-option value="safe">安全：文件路径及大小匹配，再校验</a-select-option>
            <a-select-option value="fast">快速：文件路径及大小匹配，跳过校验</a-select-option>
            <a-select-option value="compatible">兼容：名称及总大小匹配，再校验</a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item v-if="rss.autoReseed || rss.onlyReseed" label="辅种应用选择规则" name="reseedRespectRules" extra="旧任务默认保持原行为，辅种先于普通选择规则；新任务默认要求匹配选择规则。拒绝规则始终优先。">
          <a-checkbox v-model:checked="rss.reseedRespectRules">要求匹配选择规则</a-checkbox>
        </a-form-item>
        <a-form-item v-if="rss.onlyReseed" label="辅种等待（分钟）" name="reseedWaitMinutes" extra="未命中时保留候选，等待原种完成；0 关闭，最多 1440 分钟，每个 RSS 最多 500 条。">
          <a-input-number :min="0" :max="1440" v-model:value="rss.reseedWaitMinutes" />
        </a-form-item>
        <a-form-item label="同优先级规则顺序" name="ruleOrder" extra="旧任务保留原规则文件顺序；新任务可按任务中选择规则的顺序匹配。">
          <a-select v-model:value="rss.ruleOrder"><a-select-option value="legacy">兼容旧规则顺序</a-select-option><a-select-option value="configured">按任务配置顺序</a-select-option></a-select>
        </a-form-item>
        <a-form-item
          label="跳过大小相同种子"
          name="skipSameTorrent"
          extra="跳过所有下载器内存在大小相同种子的种子"
          :rules="[{ required: true, message: '${label}不可为空! ' }]">
          <a-checkbox v-model:checked="rss.skipSameTorrent">跳过大小相同种子</a-checkbox>
        </a-form-item>
        <a-form-item
          label="推送种子文件"
          name="pushTorrentFile"
          extra="是否直接推送种子文件, 默认推送种子下载链接至下载器">
          <a-checkbox v-model:checked="rss.pushTorrentFile">推送种子文件</a-checkbox>
        </a-form-item>
        <a-form-item
          label="自定义正则替换"
          name="useCustomRegex"
          extra="在解析 RSS 前替换原始 XML 中的任意文本，包括标题、简介、链接、标签和属性；同时支持推送种子文件及下载链接。旧任务保留原来的下载链接替换范围。">
          <a-checkbox v-model:checked="rss.useCustomRegex" @change="ensureRegexRules">启用正则替换</a-checkbox>
        </a-form-item>
        <a-form-item v-if="rss.useCustomRegex" label="替换范围" name="regexScope">
          <a-select v-model:value="rss.regexScope" @change="ensureRegexRules">
            <a-select-option value="xml">整个 RSS XML 文本</a-select-option>
            <a-select-option value="download">仅下载链接（兼容旧配置）</a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item v-if="rss.useCustomRegex && rss.regexScope === 'xml'" label="全文替换规则"
          extra="从上到下依次替换；使用 g 替换全部匹配，i 忽略大小写，s 允许点号跨行。支持 $1 等捕获组，替换内容留空表示删除。替换后必须保持合法 XML；XML 属性中的 &amp; 应写为 &amp;amp;。">
          <div v-for="(rule, index) in rss.regexRules" :key="index" class="regex-rule">
            <a-space class="regex-rule-heading"><strong>规则 {{ index + 1 }}</strong><a-button size="small" :disabled="index === 0" @click="moveRegexRule(index, -1)">上移</a-button><a-button size="small" :disabled="index === rss.regexRules.length - 1" @click="moveRegexRule(index, 1)">下移</a-button><a-button size="small" danger @click="rss.regexRules.splice(index, 1)">删除</a-button></a-space>
            <a-form-item label="匹配表达式" :name="['regexRules', index, 'regexStr']" :rules="[{ required: true, message: '请输入正则表达式' }]">
              <a-textarea v-model:value="rule.regexStr" :auto-size="{ minRows: 2, maxRows: 6 }" placeholder="例如 /旧文本/g 或 /old\.example\.com/g" />
            </a-form-item>
            <a-form-item label="替换为" :name="['regexRules', index, 'replaceStr']">
              <a-textarea v-model:value="rule.replaceStr" :auto-size="{ minRows: 2, maxRows: 6 }" placeholder="替换后的文本，留空表示删除匹配内容" />
            </a-form-item>
          </div>
          <a-button size="small" @click="addRegexRule">新增替换规则</a-button>
          <p class="regex-help">点击下方「试运行」查看替换后解析出的种子；规则导致 XML 无法解析时会显示错误，不执行添加。</p>
        </a-form-item>
        <a-form-item
          label="正则表达式"
          v-if="rss.useCustomRegex && rss.regexScope === 'download'"
          name="regexStr"
          extra="格式: /pattern/flags；兼容旧行为，仅在推送下载链接时生效，不修改 RSS XML。"
          :rules="[{ required: true, message: '${label}不可为空! ' }]">
          <a-input size="small" v-model:value="rss.regexStr"/>
        </a-form-item>
        <a-form-item
          label="替换为"
          v-if="rss.useCustomRegex && rss.regexScope === 'download'"
          name="replaceStr">
          <a-input size="small" v-model:value="rss.replaceStr"/>
        </a-form-item>
        <a-form-item
          label="拒绝规则"
          name="rejectRules"
          extra="拒绝规则, 种子状态符合其中一个时即触发拒绝种子操作">
          <a-checkbox-group style="width: 100%;" v-model:value="rss.rejectRules">
            <a-row>
              <a-col v-for="rssRule of rssRules" :span="8" :key="rssRule.id">
                <a-checkbox  v-model:value="rssRule.id">{{ rssRule.alias }}</a-checkbox>
              </a-col>
            </a-row>
          </a-checkbox-group>
        </a-form-item>
        <a-form-item
          label="选择规则"
          name="acceptRules"
          extra="选择规则, 种子状态符合其中一个时即触发添加种子操作">
          <a-checkbox-group style="width: 100%;" v-model:value="rss.acceptRules">
            <a-row>
              <a-col v-for="rssRule of rssRules" :span="8" :key="rssRule.id">
                <a-checkbox  v-model:value="rssRule.id">{{ rssRule.alias }}</a-checkbox>
              </a-col>
            </a-row>
          </a-checkbox-group>
        </a-form-item>
        <a-form-item
          :wrapperCol="isMobile() ? { span:24 } : { span: 21, offset: 3 }">
          <a-button type="primary" html-type="submit" style="margin-top: 24px; margin-bottom: 48px;">应用 | 完成</a-button>
          <a-button style="margin-left: 12px; margin-top: 24px; margin-bottom: 48px;" @click="clearRss()">清空</a-button>
          <a-button type="primary" style="margin-left: 12px; margin-top: 24px; margin-bottom: 48px;" @click="dryrun()">试运行</a-button>
        </a-form-item>
      </a-form>
    </div>
  </div>
  <a-modal
    v-model:visible="modalVisible"
    title="RSS 试运行"
    width="1440px"
    :footer="null">
    <div style="text-align: left; ">
      <a-alert message="注意事项" type="info" >
        <template #description>
          RSS 试运行检查规则分流和当前下载器容量，不预占名额、不检测免费或 HR 状态、不执行辅种或下载。实际添加前会重新检查容量。
          <br>
          RSS 链接: {{ rss.rssUrls[0] }}
        </template>
      </a-alert>
      <a-form
        labelAlign="right"
        :labelWrap="true"
        size="small"
        :labelCol="{ span: 6 }"
        :wrapperCol="{ span: 18 }"
        autocomplete="off">
        <a-form-item
          :wrapperCol="{ span:24 }">
          <a-table
            :style="`font-size: ${isMobile() ? '12px': '14px'};`"
            :columns="dryrunColumns"
            size="small"
            :data-source="dryrunResult"
            :pagination="false"
            :scroll="{ x: 960 }"
          >
            <template #title>
              <span style="font-size: 16px; font-weight: bold;">种子列表</span>
            </template>
            <template #bodyCell="{ column, record }">
              <template v-if="column.dataIndex === 'size'">
                {{ $formatSize(record.size) }}
              </template>
            </template>
          </a-table>
        </a-form-item>
        <a-form-item
          :wrapperCol="isMobile() ? { span:24 } : { span: 6, offset: 18 }">
          <a-button @click="() => modalVisible = false">取消</a-button>
        </a-form-item>
      </a-form>
    </div>
  </a-modal>
</template>
<script>
import DownloaderGroupSelect from '@/components/DownloaderGroupSelect';
export default {
  components: { DownloaderGroupSelect },
  data () {
    const columns = [
      {
        title: 'ID',
        dataIndex: 'id',
        width: 18,
        fixed: true
      }, {
        title: '别名',
        dataIndex: 'alias',
        sorter: (a, b) => a.alias.localeCompare(b.alias),
        defaultSortOrder: 'ascend',
        width: 20
      }, {
        title: '启用',
        dataIndex: 'enable',
        width: 15
      }, {
        title: '运行状态 / 定时计划',
        dataIndex: 'scheduleState',
        width: 60
      }, {
        title: '下载器',
        dataIndex: 'clientArr',
        width: 40
      }, {
        title: '推送消息',
        dataIndex: 'pushNotify',
        width: 20
      }, {
        title: '操作',
        width: 28
      }
    ];
    const dryrunColumns = [
      {
        title: '种子标题',
        dataIndex: 'name',
        width: 144
      }, {
        title: '种子大小',
        dataIndex: 'size',
        width: 14
      }, {
        title: '命中规则',
        dataIndex: 'matchedRule',
        width: 28
      }, {
        title: '目标下载器',
        dataIndex: 'downloader',
        width: 28
      }, {
        title: '分配说明',
        dataIndex: 'routingDetails',
        width: 60
      }, {
        title: '结果',
        dataIndex: 'status',
        width: 60
      }
    ];
    return {
      columns,
      dryrunColumns,
      modalVisible: false,
      rssList: [],
      downloaders: [],
      downloaderGroups: [],
      notifications: [],
      rssRules: [],
      rss: {},
      defaultRss: {
        useCustomRegex: false,
        regexScope: 'xml',
        regexRules: [],
        clientArr: [],
        clientGroupIds: [],
        reseedGroupIds: [],
        enable: false,
        dailyWindowEnabled: false,
        windowStart: '23:00',
        windowEnd: '08:00',
        expireEnabled: false,
        expireAt: '',
        scrapeFree: false,
        scrapeHr: false,
        autoReseed: false,
        reseedMode: 'safe',
        reseedRespectRules: true,
        reseedWaitMinutes: 120,
        ruleOrder: 'configured',
        onlyReseed: false,
        maxSleepTime: 600,
        skipSameTorrent: true,
        pushTorrentFile: true,
        cron: '* * * * *',
        addCountPerHour: '',
        pushNotify: false,
        acceptRules: [],
        rejectRules: [],
        reseedClients: [],
        rssUrls: ['']
      },
      loading: true,
      registCode: []
    };
  },
  methods: {
    async validateDownloaders () {
      if (!(this.rss.clientArr || []).length && !(this.rss.clientGroupIds || []).length) throw new Error('请选择下载器或引用下载器组');
    },
    async listGroups () {
      try { this.downloaderGroups = (await this.$api().downloaderGroup.list()).data; } catch (error) { this.$message().error(error.message); }
    },
    groupNames (ids) { return (ids || []).map(id => this.downloaderGroups.find(group => group.id === id)?.alias || '已失效：' + id).join(' / '); },
    downloaderNames (record) {
      const ids = new Set([...(record.clientArr || []), ...(record.clientGroupIds || []).flatMap(id => this.downloaderGroups.find(group => group.id === id)?.clientIds || [])]);
      return this.downloaders.filter(client => ids.has(client.id)).map(client => client.alias).join(' / ') || '暂无成员';
    },
    scheduleLabel (record) {
      return { running: '运行中', outside: '时段外暂停', expired: '已到期关闭', disabled: '未启用' }[record.scheduleState?.status] || (record.enable ? '运行中' : '未启用');
    },
    scheduleColor (record) {
      return { running: 'success', outside: 'orange', expired: 'error', disabled: 'default' }[record.scheduleState?.status] || 'default';
    },
    isMobile () {
      if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
        return true;
      } else {
        return false;
      }
    },
    async listRss () {
      try {
        const res = await this.$api().rss.list();
        this.rssList = res.data;
      } catch (e) {
        this.$message().error(e.message);
      }
    },
    async listNotification () {
      try {
        const res = await this.$api().notification.list();
        this.notifications = res.data.sort((a, b) => a.alias.localeCompare(b.alias));
      } catch (e) {
        this.$message().error(e.message);
      }
    },
    async listRssRule () {
      try {
        const res = await this.$api().rssRule.list();
        this.rssRules = res.data.sort((a, b) => a.alias.localeCompare(b.alias));
      } catch (e) {
        this.$message().error(e.message);
      }
    },
    async listDownloader () {
      try {
        const res = await this.$api().downloader.list();
        this.downloaders = res.data.sort((a, b) => a.alias.localeCompare(b.alias));
      } catch (e) {
        this.$message().error(e.message);
      }
    },
    async modifyRss () {
      try {
        await this.$api().rss.modify({ ...this.rss });
        this.$message().success((this.rss.id ? '编辑' : '新增') + '成功, 列表正在刷新...');
        setTimeout(() => this.listRss(), 1000);
        this.clearRss();
      } catch (e) {
        this.$message().error(e.message);
      }
    },
    async dryrun () {
      try {
        const res = await this.$api().rss.dryrun({ ...this.rss });
        this.dryrunResult = res.data.map(torrent => ({ ...torrent, routingDetails: (torrent.candidates || []).map(c => c.alias + ': ' + (c.reason || '可用')).join('; ') }));
        this.modalVisible = true;
      } catch (e) {
        this.$message().error(e.message);
      }
    },
    async enableTask (record) {
      try {
        await this.$api().rss.modify({ ...record });
        this.$message().success('修改成功, 列表正在刷新...');
        setTimeout(() => this.listRss(), 1000);
        this.clearRss();
      } catch (e) {
        record.enable = !record.enable;
        this.$message().error(e.message);
      }
    },
    modifyClick (row) {
      this.rss = { ...this.defaultRss, ...row, regexScope: row.regexScope || 'download', regexRules: (row.regexRules || []).map(rule => ({ ...rule })) };
    },
    cloneClick (row) {
      this.rss = { ...this.defaultRss, ...JSON.parse(JSON.stringify(row)) };
      this.rss.regexScope = row.regexScope || 'download';
      this.rss.regexRules = this.rss.regexRules || [];
      this.rss.id = null;
      this.rss.alias = this.rss.alias + '-克隆';
    },
    async deleteRss (row) {
      try {
        await this.$api().rss.delete(row.id);
        this.$message().success('删除成功, 列表正在刷新...');
        await this.listRss();
      } catch (e) {
        this.$message().error(e.message);
      }
    },
    clearRss () {
      this.rss = {
        ...this.defaultRss,
        regexRules: [],
        acceptRules: [],
        clientArr: [],
        clientGroupIds: [],
        reseedGroupIds: [],
        rejectRules: [],
        reseedClients: [],
        rssUrls: ['']
      };
    },
    ensureRegexRules () {
      if (this.rss.useCustomRegex && this.rss.regexScope === 'xml' && !this.rss.regexRules?.length) {
        this.rss.regexRules = [{ regexStr: this.rss.regexStr || '', replaceStr: this.rss.replaceStr || '' }];
      }
    },
    addRegexRule () {
      if (!Array.isArray(this.rss.regexRules)) this.rss.regexRules = [];
      this.rss.regexRules.push({ regexStr: '', replaceStr: '' });
    },
    moveRegexRule (index, direction) {
      const target = index + direction;
      if (target < 0 || target >= this.rss.regexRules.length) return;
      const rule = this.rss.regexRules.splice(index, 1)[0];
      this.rss.regexRules.splice(target, 0, rule);
    }
  },
  async mounted () {
    this.clearRss();
    this.listNotification();
    this.listDownloader();
    this.listGroups();
    this.listRssRule();
    this.listRss();
    this.statusTimer = setInterval(() => { this.listRss(); this.listGroups(); }, 15000);
  },
  beforeUnmount () {
    clearInterval(this.statusTimer);
  }
};
</script>
<style scoped>
.rss {
  width: 100%;
  max-width: 1440px;
  margin: 0 auto;
}
.regex-rule { border: 1px solid rgba(128, 128, 128, .25); padding: 16px; border-radius: 8px; margin-bottom: 12px; }
.regex-rule-heading { margin-bottom: 16px; }
.regex-help { margin-top: 10px; opacity: .65; font-size: 13px; }
.schedule-inputs { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; margin-top: 12px; }
.schedule-inputs .ant-form-item { margin-bottom: 0; }
.schedule-expiry { margin-top: 12px; }
</style>
