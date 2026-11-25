// Pass the JSON copied from Settings through EASYSSH_MCP_CONFIG.
import readline from 'node:readline';
const config=JSON.parse(process.env.EASYSSH_MCP_CONFIG??'{}');
const url=new URL(config.url);
if(url.hostname!=='127.0.0.1'||url.protocol!=='http:'||typeof config.token!=='string')throw new Error('Invalid easyssh bridge configuration');
const definitions=[
 ['list_connections','List saved connections',{}],
 ['list_sessions','List visible terminal sessions',{}],
 ['open_connection','Open a saved connection in the visible app',{id:{type:'string'}}],
 ['read_terminal','Read the last 200 terminal lines',{id:{type:'string'}}],
 ['type_terminal','Type visible terminal input. Include a newline to execute.',{id:{type:'string'},text:{type:'string',maxLength:8192}}],
];
const lines=readline.createInterface({input:process.stdin});
for await(const line of lines){
 let request;
 try{
  request=JSON.parse(line);if(request.id===undefined)continue;
  let result;
  if(request.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'easyssh',version:'1.0.0'}};
  else if(request.method==='ping')result={};
  else if(request.method==='tools/list')result={tools:definitions.map(([name,description,properties])=>({name,description,inputSchema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}}))};
  else if(request.method==='tools/call'){
   if(!definitions.some(([name])=>name===request.params?.name))throw new Error('Unknown tool');
   const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${config.token}`},body:JSON.stringify({tool:request.params.name,arguments:request.params.arguments??{}}),signal:AbortSignal.timeout(95000)});
   if(!response.ok)throw new Error(`Bridge returned ${response.status}`);
   const data=await response.json();result={content:[{type:'text',text:JSON.stringify(data)}],isError:!!data?.error};
  }else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}})+'\n');continue;}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
 }catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request?.id??null,error:{code:-32603,message:'Request failed. Check that easyssh agent access is enabled and the configuration is current.'}})+'\n');}
}
