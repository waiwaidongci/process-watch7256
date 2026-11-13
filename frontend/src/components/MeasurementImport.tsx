import {ChangeEvent,useMemo,useRef,useState} from 'react';import {CheckCircle2,Upload,X} from 'lucide-react';import {ApiError,importMeasurements} from '../api/streams';import {useAuth} from '../stores/auth';import {ParseResult,ParsedRow,parseMeasurementCsv,toMicron} from '../utils/import';import {ImportConflict,MeasurementImportResult} from '../types/domain';import {number} from '../utils/format';import {useAction} from '../hooks/useAction';

const DEFAULT_UNIT='μm';
const PREVIEW=8;

function rejectionMessage(error:unknown){
  if(error instanceof ApiError&&error.detail&&typeof error.detail==='object'){
    const detail=error.detail as {message?:string;conflicts?:ImportConflict[]};
    return {message:detail.message||'整批已拒绝',conflicts:detail.conflicts||[]};
  }
  return {message:(error as Error).message,conflicts:[] as ImportConflict[]};
}

export function MeasurementImport({streamId,streamCode,onImported}:{streamId:number;streamCode:string;onImported:()=>Promise<void>|void}){
  const {user}=useAuth();const action=useAction();const [open,setOpen]=useState(false);const [text,setText]=useState('');const [fileName,setFileName]=useState('');const [defaultUnit,setDefaultUnit]=useState(DEFAULT_UNIT);const [result,setResult]=useState<MeasurementImportResult|null>(null);const [failure,setFailure]=useState<{message:string;conflicts:ImportConflict[]}|null>(null);const inputRef=useRef<HTMLInputElement>(null);const busy=action.busy;
  const parsed=useMemo<ParseResult>(()=>text.trim()?parseMeasurementCsv(text,defaultUnit):{rows:[],issues:[]},[text,defaultUnit]);
  const canImport=parsed.rows.length>0&&parsed.issues.length===0&&!busy;
  function reset(){setText('');setFileName('');setResult(null);setFailure(null);if(inputRef.current)inputRef.current.value=''}
  function close(){setOpen(false);reset()}
  async function choose(event:ChangeEvent<HTMLInputElement>){const file=event.target.files?.[0];if(!file)return;setFileName(file.name);setText(await file.text());setResult(null);setFailure(null)}
  async function submit(){if(!canImport)return;await action.execute(async()=>{setResult(null);setFailure(null);try{const response=await importMeasurements(streamId,parsed.rows.map((row:ParsedRow)=>({source_key:row.source_key,sequence:row.sequence,measured_at:row.measured_at,value:row.value,unit:row.unit||defaultUnit,line:row.line})));setResult(response);setText('');setFileName('');if(inputRef.current)inputRef.current.value='';await onImported()}catch(error){setFailure(rejectionMessage(error))}})}
  if(user?.role==='viewer')return null;
  return <section className="import-panel">
    <div className="import-top"><div><span className="eyebrow">INSTRUMENT RE-UPLOAD / 补传</span><h2>按批导入涂层读数</h2><p>仪表可能以 μm 或 nm 输出；导入时统一换算为 μm 参与计算，原值与单位一并保留。相同来源编号的等值重传不新增，整批全成或全拒。</p></div>{!open&&<button className="outline" onClick={()=>setOpen(true)}><Upload size={15}/>导入测量批次</button>}{open&&<button className="outline" onClick={close}><X size={15}/>收起</button>}</div>
    {open&&<div className="import-body">
      <div className="import-controls">
        <label>CSV 文件<input ref={inputRef} type="file" accept=".csv,text/csv,text/plain" aria-label="导入CSV文件" onChange={choose}/></label>
        <label>无单位列时按此单位解读<select aria-label="默认单位" value={defaultUnit} onChange={e=>{setDefaultUnit(e.target.value);setResult(null);setFailure(null)}}><option value="μm">微米 μm</option><option value="nm">纳米 nm</option></select></label>
      </div>
      <p className="caption">列名可用：来源编号 / 时间序号 / 采样时间 / 膜厚 / 单位（也接受 source_key、sequence、measured_at、value、unit）。读数可写成 <span className="mono">0.0123 μm</span> 或 <span className="mono">12.3 nm</span>；{fileName?`已载入 ${fileName}。`:'也可以把表格粘贴到下方。'}</p>
      <textarea aria-label="粘贴测量批次" className="import-textarea" placeholder={'source_key,sequence,measured_at,value,unit\n'+streamCode+'-0241,241,2026-11-02T16:00:00+00:00,0.0198,μm'} value={text} onChange={e=>{setText(e.target.value);setResult(null);setFailure(null)}}/>
      {parsed.issues.length>0&&<div role="alert" className="import-alert"><b>{parsed.issues.length} 行无法解析，请修正后再导入：</b><ul>{parsed.issues.slice(0,20).map(issue=><li key={issue.line}>第 {issue.line} 行：{issue.message}</li>)}{parsed.issues.length>20&&<li>……其余 {parsed.issues.length-20} 行从略</li>}</ul></div>}
      {parsed.rows.length>0&&<div className="import-preview"><div className="section-top"><span className="eyebrow">PREVIEW / 预计写入</span><span className="mono">{parsed.rows.length} 行 · 换算为 μm 后参与分析</span></div><div className="table-wrap"><table><thead><tr><th>原行</th><th>来源编号</th><th>序号</th><th>采样时间</th><th>原值</th><th>换算 / μm</th></tr></thead><tbody>{parsed.rows.slice(0,PREVIEW).map(row=><tr key={row.line}><td className="mono">{row.line}</td><td className="mono">{row.source_key}</td><td>#{row.sequence}</td><td>{row.measured_at}</td><td className="mono">{row.value} {row.unit||defaultUnit}</td><td className="mono">{number(toMicron(row.value,row.unit),6)}</td></tr>)}</tbody></table></div>{parsed.rows.length>PREVIEW&&<small>另有 {parsed.rows.length-PREVIEW} 行未在预览中展示。</small>}</div>}
      {failure&&<div role="alert" className="import-alert"><b>{failure.message}</b>{failure.conflicts.length>0&&<ul>{failure.conflicts.map((conflict,index)=><li key={index}>第 {conflict.line} 行 · {conflict.source_key}（{conflict.kind}）：{conflict.reason}{conflict.existing_lines.length>0&&<span> 关联原行：第 {conflict.existing_lines.join('、')} 行</span>}</li>)}</ul>}</div>}
      {result&&<div role="status" className="import-success"><CheckCircle2 size={16}/><b>批次已核对</b><span>新增 <b>{result.inserted}</b> 条 · 重复跳过 <b>{result.duplicates}</b> 条 · 本批共 {result.total} 条</span>{result.duplicate_lines.length>0&&<small>重复原行：第 {result.duplicate_lines.slice(0,30).join('、')} 行{result.duplicate_lines.length>30?' …':''}</small>}</div>}
      <div className="import-actions"><button className="primary" disabled={!canImport} onClick={submit}><Upload size={15}/>{busy?'正在核对整批…':parsed.rows.length?`导入 ${parsed.rows.length} 行`:'导入整批'}</button><small>{parsed.issues.length>0?'请先修正无法解析的行；本工具不会静默跳过原行。':'导入前请确认所选测量流为 '+streamCode+'；任一冲突都会整批回滚。'}</small></div>
    </div>}
  </section>
}
