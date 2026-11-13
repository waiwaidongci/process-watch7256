export interface ParsedRow{line:number;source_key:string;sequence:number;measured_at:string;value:number;unit:string}
export interface ParseIssue{line:number;message:string}
export interface ParseResult{rows:ParsedRow[];issues:ParseIssue[]}

type Field=keyof Omit<ParsedRow,'line'>;
const ALIASES:Record<string,Field>={
  '来源编号':'source_key','source_key':'source_key','来源':'source_key','source':'source_key','编号':'source_key','key':'source_key','sampleid':'source_key','sample_id':'source_key',
  '时间序号':'sequence','sequence':'sequence','序号':'sequence','index':'sequence','seq':'sequence',
  '采样时间':'measured_at','measured_at':'measured_at','时间':'measured_at','time':'measured_at','timestamp':'measured_at','测量时间':'measured_at',
  '膜厚':'value','读数':'value','value':'value','thickness':'value','reading':'value','测量值':'value',
  '单位':'unit','unit':'unit','units':'unit',
};
const ORDER:Field[]=['source_key','sequence','measured_at','value','unit'];
const UNIT_ALIASES:Record<string,string>={'μm':'μm','µm':'μm','um':'μm','微米':'μm','micron':'μm','micron(s)':'μm','micrometer':'μm','nm':'nm','纳米':'nm','nanometer':'nm'};
export function normalizeUnit(raw:string):string{return UNIT_ALIASES[raw.trim().toLowerCase()]||raw.trim()}
export function toMicron(value:number,unit:string):number{return normalizeUnit(unit)==='nm'?value/1000:value}
const UNIT_SUFFIX=/\s*(?:[（(\[]\s*(?:μm|µm|um|nm|微米|纳米)?\s*[）)\]]|(?:\/|per)\s*(?:μm|µm|um|nm|微米|纳米))\s*$/i;

function normalizeHeader(cell:string):string{
  const text=cell.replace(/^﻿/,'').trim().toLowerCase().replace(/\s+/g,'_').replace(/__/g,'_');
  return text.replace(UNIT_SUFFIX,'').replace(/^_+|_+$/g,'');
}

function headerUnit(cell:string):string{
  const match=cell.match(/(?:[（(\[]|(?:\/|per))\s*(μm|µm|um|nm|微米|纳米)\s*(?:[）)\]]|$)/i);
  return match?match[1]:'';
}

function parseCsv(text:string):string[][]{
  const rows:string[][]=[];let row:string[]=[];let field='';let quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){
      if(c==='"'){if(text[i+1]==='"'){field+='"';i++}else quoted=false}else field+=c;
    }else if(c==='"'){quoted=true}
    else if(c===','){row.push(field);field=''}
    else if(c==='\n'){row.push(field);rows.push(row);row=[];field=''}
    else if(c!=='\r')field+=c;
  }
  if(field.length||row.length){row.push(field);rows.push(row)}
  return rows;
}

function headerIndex(cells:string[]):{map:Partial<Record<Field,number>>;units:Partial<Record<Field,string>>}|null{
  const map:Partial<Record<Field,number>>={};const units:Partial<Record<Field,string>>={};
  cells.forEach((cell,index)=>{const key=ALIASES[normalizeHeader(cell)];if(key&&map[key]===undefined){map[key]=index;units[key]=headerUnit(cell)}});
  return map.source_key!==undefined&&map.value!==undefined?{map,units}:null;
}

function normalizeNumber(numeric:string):string{
  if(numeric.includes(',')&&numeric.includes('.'))return numeric.replace(/,/g,'');
  if(numeric.includes(',')){
    const parts=numeric.split(',');
    if(parts.length===2)return parts[0]+'.'+parts[1];
    if(parts.length>2&&parts.slice(1).every(part=>part.length===3))return parts.join('');
    return numeric;
  }
  return numeric;
}

function splitValue(raw:string,cellUnit:string,defaultUnit:string):{value:number;unit:string}{
  const text=raw.trim();
  const match=text.match(/^([+-]?[\d\s.,]+(?:[eE][+-]?\d+)?)\s*([^\d\s.,].*?)?$/);
  if(!match)return {value:NaN,unit:cellUnit||defaultUnit};
  const numeric=normalizeNumber(match[1].replace(/\s+/g,''));
  const suffix=(match[2]||'').trim();
  return {value:Number(numeric),unit:normalizeUnit(suffix||cellUnit.trim()||defaultUnit)};
}

export function parseMeasurementCsv(text:string,defaultUnit:string):ParseResult{
  const lines=parseCsv(text.replace(/^﻿/,''));
  const rows:ParsedRow[]=[];const issues:ParseIssue[]=[];
  const first=lines.findIndex(cells=>cells.some(cell=>cell.trim()!==''));
  const head=first>=0?headerIndex(lines[first]):null;
  const headerRow=first>=0?lines[first]:[];
  const start=head?first+1:0;
  for(let i=start;i<lines.length;i++){
    const cells=lines[i];const line=i+1;
    if(cells.every(cell=>cell.trim()===''))continue;
    const at=(key:Field)=>head&&head.map[key]!==undefined?cells[head.map[key]!]??'':head?cells[ORDER.indexOf(key)]??'':cells[ORDER.indexOf(key)]??'';
    const source_key=at('source_key').trim();
    const sequenceText=at('sequence').trim();
    const measured_at=at('measured_at').trim();
    const columnUnit=head?head.units.value||headerUnit(headerRow[ORDER.indexOf('value')]||''):'';
    const {value,unit}=splitValue(at('value'),at('unit'),columnUnit||defaultUnit);
    if(!source_key){issues.push({line,message:'来源编号为空'});continue}
    if(!/^\d+$/.test(sequenceText)||Number(sequenceText)<1){issues.push({line,message:`时间序号必须为正整数（当前为“${sequenceText}”）`});continue}
    if(!measured_at){issues.push({line,message:'采样时间为空'});continue}
    if(Number.isNaN(Date.parse(measured_at))){issues.push({line,message:`采样时间需为ISO 8601时间（当前为“${measured_at}”）`});continue}
    if(unit!=='μm'&&unit!=='nm'){issues.push({line,message:`单位仅支持微米 μm 或纳米 nm（当前为“${unit}”）`});continue}
    if(!Number.isFinite(value)||value<=0){issues.push({line,message:`读数必须为大于0的数字（当前为“${at('value').trim()}”）`});continue}
    rows.push({line,source_key,sequence:Number(sequenceText),measured_at,value,unit:normalizeUnit(unit)});
  }
  return {rows,issues};
}
