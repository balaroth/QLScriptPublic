/*
------------------------------------------
@Author: sm
@Date: 2024.06.07 19:15
@Description:  
cron: 30 9 * * 1
------------------------------------------
#Notice:   
stokke 微信小程序 每周签到得积分 
WeChatCodeServer 填写wx_server_url wx_auth 用于获取code 
变量名称：stokke
⚠️【免责声明】
------------------------------------------
1、此脚本仅用于学习研究，不保证其合法性、准确性、有效性，请根据情况自行判断，本人对此不承担任何保证责任。
2、由于此脚本仅用于学习研究，您必须在下载后 24 小时内将所有内容从您的计算机或手机或任何存储设备中完全删除，若违反规定引起任何事件本人对此均不负责。
3、请勿将此脚本用于任何商业或非法目的，若违反规定请自行对此负责。
4、此脚本涉及应用与本人无关，本人对因此引起的任何隐私泄漏或其他后果不承担任何责任。
5、本人对任何脚本引发的问题概不负责，包括但不限于由脚本错误引起的任何损失和损害。
6、如果任何单位或个人认为此脚本可能涉嫌侵犯其权利，应及时通知并提供身份证明，所有权证明，我们将在收到认证文件确认后删除此脚本。
7、所有直接或间接使用、查看此脚本的人均应该仔细阅读此声明。本人保留随时更改或补充此声明的权利。一旦您使用或复制了此脚本，即视为您已接受此免责声明。
*/

const {
    Env
} = require("../tools/env")
const $ = new Env("stokke小程序");
const WeChatServer = require("./wcs.js"); 
let ckName = `stokke`;
const strSplitor = "#";
const axios = require("axios");
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const READ_ONLY=process.env.STOKKE_READ_ONLY==='1'||process.env.QL_READ_ONLY==='1';
const STATE=path.join(__dirname,'.stokke_write_state.json'),LOCK=path.join(__dirname,'.stokke_write.lock');
function weekKey(now=Date.now()){const d=new Date(now+28800000);const day=d.getUTCDay()||7;d.setUTCDate(d.getUTCDate()-day+1);return d.toISOString().slice(0,10)}
function stateRead(){try{const d=JSON.parse(fs.readFileSync(STATE));if(!d||typeof d!=='object'||Array.isArray(d))throw Error('bad_state');for(const v of Object.values(d)){if(!v||!/^\d{4}-\d{2}-\d{2}$/.test(v.week)||!['attempting','unknown','success'].includes(v.status)||!Number.isInteger(v.attempts)||v.attempts<0||v.attempts>2)throw Error('bad_state_entry')}return d}catch(e){if(e.code==='ENOENT')return{};throw e}}
function stateSave(d){if(READ_ONLY)throw Error('readonly_state_blocked');const b=Buffer.from(JSON.stringify(d)),tmp=STATE+'.tmp.'+process.pid+'.'+crypto.randomBytes(6).toString('hex');let fd;try{fd=fs.openSync(tmp,'wx',0o600);let o=0;while(o<b.length){const n=fs.writeSync(fd,b,o,b.length-o);if(!Number.isInteger(n)||n<=0||n>b.length-o)throw Error('short_write');o+=n}fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,STATE);const dir=fs.openSync(__dirname,'r');try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}if(!fs.readFileSync(STATE).equals(b))throw Error('state_readback')}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp)}}
function weeklyTask(d){if(!Array.isArray(d?.taskQueryRespList))throw Error('task_list_invalid');const rows=d.taskQueryRespList.flatMap(x=>Array.isArray(x?.scoreTaskListResps)?x.scoreTaskListResps:[]).filter(x=>x?.taskId===4&&x.type===2&&x.taskName==='每周签到');if(rows.length!==1||typeof rows[0].ifFinish!=='boolean')throw Error('weekly_authority_invalid');return rows[0]}

const defaultUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001e31) NetType/WIFI Language/zh_CN miniProgram"
let wechat = new WeChatServer({
    url: process.env.wx_server_url || 'http://192.168.31.196:12081',
    appid: 'wxe232c36aaca3dc1a',
    auth: process.env.wx_auth || "your-api-key",

}
);

class Task {
    constructor(env) {
        this.index = $.userIdx++
        this.user = env.split(strSplitor);
        this.token = null
        this.wcsid = this.user[0]
        this.isSign = false
        this.writeAttempted=0;this.outcome='pending';
    }

    async run() {
        //随机延迟5-30s 模拟人工操作
       await $.wait(Math.floor(Math.random() * 20 + 5) * 1000);
        let { data: codeRes } = await wechat.getCode(this.wcsid)
        if (codeRes.status) {
            await this.getUserToken(codeRes.data.code)
        }
        if (!this.token) {
            throw new Error('login_token_missing');
        }
        await this.getUserInfo();
        await this.doSign();
    }
    async getUserToken(code) {
        let data = ({
            "code": code,
            "spread_spid": 0,
            "type": "routine",
            "inviteCode": "",
            "inviteTime": ""
        });

        let options = {
            method: 'POST',
            url: 'https://www.stokkeshop.cn/api/front/wechat/authorize/program/login?code=' + code,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249',
                'Content-Type': 'application/json',
                'xweb_xhr': '1',
                'Authori-zation': '',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'Referer': 'https://servicewechat.com/wxe232c36aaca3dc1a/54/page-frame.html',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            },
            data: data
        };

        let {
            data: result
        } = await axios.request(options);

        if (result?.code === 200 && typeof result.data?.token === 'string' && result.data.token) {
            this.token = result.data.token;
            $.log(`🌸账号[${this.index}] 获取用户Token成功`);
        } else {
            throw new Error('login_rejected');
        }
    }
    async getUserInfo() {
        let options = {
            method: 'GET',
            url: `https://www.stokkeshop.cn/api/front/user`,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249',
                'Content-Type': 'application/json',
                'xweb_xhr': '1',
                'Authori-zation': '' + this.token + '',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'Referer': 'https://servicewechat.com/wxe232c36aaca3dc1a/54/page-frame.html',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            }
        }
        let {
            data: result
        } = await axios.request(options);
        if (result?.code === 200 && Number.isFinite(result.data?.integral)) {
            this.points=result.data.integral;
            $.log(`🌸账号[${this.index}] 积分[${this.points}]`);
        } else {
            throw new Error('member_response_invalid');
        }
    }

    async queryWeeklyTask() {
        const {data:r}=await axios.request({method:'GET',url:'https://www.stokkeshop.cn/api/front/integral-task/queryTaskList',headers:{'Authori-zation':this.token,'Content-Type':'application/json','User-Agent':defaultUserAgent},timeout:15000});
        if(r?.code!==200)throw new Error('weekly_query_rejected');
        return weeklyTask(r.data);
    }
    async doSign() {
        // 已完成只能由官方任务列表确认；重复请求文案不构成签到成功。
        const before=await this.queryWeeklyTask();
        if(before.ifFinish){this.outcome='already';$.log('✅ 本周已签到（服务端任务记录），不重复请求');return;}
        if(READ_ONLY){this.outcome='readonly';$.log('🔒 本周未签，只读模式不发签到');return;}
        let fd;
        try{fd=fs.openSync(LOCK,'wx',0o600)}catch(e){throw new Error('concurrent_or_stale_lock');}
        try{
            const checked=await this.queryWeeklyTask();
            if(checked.ifFinish){this.outcome='already';return;}
            const all=stateRead(),key=crypto.createHash('sha256').update(this.wcsid).digest('hex'),week=weekKey();
            const previous=all[key]?.week===week?all[key]:null;
            const attempts=previous?.attempts||0;
            if(previous){
                if(previous.status==='success'||attempts>=2)throw new Error('weekly_write_limit');
                const age=Date.now()-Date.parse(previous.lastAttemptAt||'');
                if(!Number.isFinite(age)||age<1800000)throw new Error('weekly_unknown_cooldown');
                const a=await this.queryWeeklyTask();await $.wait(3000);const b=await this.queryWeeklyTask();
                if(a.ifFinish||b.ifFinish){this.outcome='already';all[key]={...previous,status:'success',confirmedAt:new Date().toISOString()};stateSave(all);return;}
            }
            all[key]={week,status:'attempting',attempts:attempts+1,lastAttemptAt:new Date().toISOString()};
            stateSave(all);
            this.writeAttempted=1;
            let writeError=null;
            try{await axios.request({method:'POST',url:'https://www.stokkeshop.cn/api/front/integral-task/finishWeekSign',headers:{'Authori-zation':this.token,'Content-Type':'application/json','User-Agent':defaultUserAgent},data:{},timeout:15000});}catch(e){writeError=e;}
            // 每次已发出的写均先查询权威状态，响应码/重复文案不直接判成功。
            let confirmed=false;
            for(const delay of [0,1000,3000]){
                if(delay)await $.wait(delay);
                try{if((await this.queryWeeklyTask()).ifFinish){confirmed=true;break;}}catch(e){}
            }
            all[key]={...all[key],status:confirmed?'success':'unknown',...(confirmed?{confirmedAt:new Date().toISOString()}:{})};stateSave(all);
            if(!confirmed)throw new Error(writeError?'weekly_write_unknown':'weekly_unconfirmed');
            this.outcome='success';$.log('✅ 本周签到已由服务端任务记录确认');
        }finally{try{fs.closeSync(fd)}finally{fs.unlinkSync(LOCK)}}
    }
}

async function main(){
    let accounts=0,failed=0,already=0,writes=0;
    try{
        if(!process.env.wx_server_url||!process.env.wx_auth)throw new Error('wechat_config_missing');
        $.checkEnv(ckName);
        if(!$.userList?.length)throw new Error('account_missing');
        accounts=$.userList.length;
        for(const user of $.userList){const t=new Task(user);try{await t.run();if(t.outcome==='already')already++;}catch(e){failed++;$.log(`账号[${t.index}] 执行失败: ${e.message}`);}writes+=t.writeAttempted;}
    }catch(e){failed++;$.log(e.message);}
    const ok=failed===0&&accounts>0;
    $.log(`[QLRUN_RESULT] ${ok?'SUCCESS':'FAILURE'} accounts=${accounts} failed=${failed} already=${already} writeAttempted=${writes} retryable=0 mode=${READ_ONLY?'只读':'任务'}`);
    return ok?0:1;
}
if(require.main===module){main().then(async rc=>{try{if($.sendMsg)await $.sendMsg()}catch(e){}process.exit(rc)}).catch(()=>process.exit(1));}
module.exports={Task,weeklyTask,weekKey,stateRead,stateSave,main};

async function getNotice() {
    try {
        let options = {
            url: `https://ghproxy.net/https://raw.githubusercontent.com/smallfawn/Note/refs/heads/main/Notice.json`,
            headers: {
                "User-Agent": defaultUserAgent,
            },
            timeout: 3000
        }
        let {
            data: res
        } = await axios.request(options);
        $.log(res)
        return res
    } catch (e) { }

}
