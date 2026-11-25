import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
type FileEntry = {name:string;path:string;directory:boolean;size:number|null};
type Directory = {path:string;parent:string;entries:FileEntry[]};
type Document = {path:string;content:string;revision:string};
type OpenDocument = Document & {session:string;original:string;crlf:boolean};
type Hooks = {confirm:(title:string,message:string)=>Promise<boolean>;notify:(message:unknown)=>void;onVisibility:(visible:boolean)=>void};
export class FileEditor {
  private session = '';
  private directory: Directory | null = null;
  private document: OpenDocument | null = null;
  private busy = false;
  private saving = false;
  private confirming = false;
  private generation = 0;
  private path: HTMLInputElement;
  private area: HTMLTextAreaElement;
  private saveButton: HTMLButtonElement;
  private status: HTMLElement;
  private title: HTMLElement;
  private fileName: HTMLElement;
  constructor(private panel:HTMLElement,private hooks:Hooks) {
    panel.innerHTML = `<header class="files-heading"><strong id="files-target">Files</strong><button id="files-close" aria-label="Close file editor">Close</button></header>
      <form class="file-path-form"><button type="button" id="files-parent" aria-label="Parent directory" title="Parent directory">&uarr;</button><input id="files-path" aria-label="Directory path" autocomplete="off" spellcheck="false"><button title="Open directory">Go</button><button type="button" id="files-refresh" title="Refresh directory">&#8635;</button></form>
      <div class="file-workspace"><nav id="file-list" aria-label="Files"></nav><section class="text-editor"><div class="editor-toolbar"><span id="file-name">No file open</span><button id="file-save" class="primary" disabled title="Save (Ctrl+S)">Save</button></div><textarea id="file-content" aria-label="File content" spellcheck="false" autocorrect="off" autocapitalize="off" autocomplete="off" wrap="off" disabled placeholder="Choose a text file to edit"></textarea></section></div><p id="file-status" role="status">UTF-8 text · Maximum 1 MiB</p>`;
    const q = <T extends HTMLElement>(selector:string)=>panel.querySelector<T>(selector)!;
    this.path=q<HTMLInputElement>('#files-path');this.area=q<HTMLTextAreaElement>('#file-content');this.saveButton=q<HTMLButtonElement>('#file-save');this.status=q('#file-status');this.title=q('#files-target');this.fileName=q('#file-name');
    q('#files-close').onclick=()=>{void this.close();};
    q<HTMLFormElement>('.file-path-form').onsubmit=e=>{e.preventDefault();void this.list(this.path.value);};
    q('#files-parent').onclick=()=>{if(this.directory)void this.list(this.directory.parent);};
    q('#files-refresh').onclick=()=>{void this.list(this.directory?.path??'.');};
    this.area.oninput=()=>this.refreshDirty();this.saveButton.onclick=()=>{void this.save();};
    this.area.addEventListener('keydown',e=>{
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();e.stopPropagation();void this.save();}
      if(e.key==='Tab'&&!e.ctrlKey&&!e.altKey&&!e.metaKey){e.preventDefault();const a=this.area.selectionStart,b=this.area.selectionEnd;this.area.setRangeText('  ',a,b,'end');this.refreshDirty();}
    });
    panel.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();e.stopPropagation();void this.save();}});
    window.addEventListener('beforeunload',e=>{if(this.dirty()){e.preventDefault();e.returnValue='';}});
  }
  private dirty(){return !!this.document&&this.area.value!==this.document.original;}
  private refreshDirty(){this.saveButton.disabled=this.saving||this.area.readOnly||!this.dirty();this.fileName.textContent=this.document?`${this.document.path}${this.dirty()?' • Unsaved':''}`:'No file open';}
  private async canDiscard(){
    if(this.saving){this.hooks.notify('Wait for the file save to finish.');return false;}
    if(!this.dirty())return true;if(this.confirming)return false;this.confirming=true;
    try{return await this.hooks.confirm('Discard unsaved edits?','Your changes have not been saved to the file.');}finally{this.confirming=false;}
  }
  async toggle(session:string,label:string){
    if(this.busy){this.hooks.notify('Wait for the current file request to finish.');return;}
    if(!this.panel.hidden&&session===this.session){await this.close();return;}
    if(session!==this.session){if(!await this.canDiscard())return;this.generation++;this.session=session;this.document=null;this.directory=null;this.area.value='';this.area.disabled=true;this.refreshDirty();}
    this.title.textContent=label;this.title.title=label;this.panel.hidden=false;this.hooks.onVisibility(true);await this.list(this.directory?.path??'.');
  }
  async close(){if(!await this.canDiscard())return;if(this.document){this.area.value=this.document.original;this.refreshDirty();}this.panel.hidden=true;this.hooks.onVisibility(false);}
  async beforeSessionClose(session:string){if(this.session!==session)return true;if(!await this.canDiscard())return false;this.generation++;this.document=null;this.session='';this.area.value='';this.area.disabled=true;this.panel.hidden=true;this.hooks.onVisibility(false);return true;}
  private async request<T>(request:unknown):Promise<T>{return invoke<T>('file_request',{sessionId:this.session,request});}
  private async list(path:string){
    if(this.busy||this.saving)return;this.busy=true;const generation=this.generation;this.status.textContent='Loading directory…';
    try{
      const directory=await this.request<Directory>({operation:'list',path});if(generation!==this.generation)return;
      this.directory=directory;this.path.value=directory.path;const list=this.panel.querySelector('#file-list')!;list.replaceChildren();
      directory.entries.sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name)).forEach(entry=>{
        const button=document.createElement('button');button.className=entry.directory?'file-directory':'file-entry';button.title=entry.path;
        const name=document.createElement('span');name.textContent=(entry.directory?'\u25b8 ':'')+entry.name;button.append(name);
        if(!entry.directory){const size=document.createElement('small');size.textContent=entry.size===null?'':entry.size<1024?`${entry.size} B`:`${Math.ceil(entry.size/1024)} KB`;button.append(size);}
        button.onclick=()=>{if(entry.directory)void this.list(entry.path);else void this.open(entry.path);};list.append(button);
        if (!entry.directory) {
          const actions = document.createElement('div');
          actions.className = 'file-transfer-actions';
          for (const [label, sudo, read] of [['Download',false,false],['Download with sudo',true,false],['Read with sudo',true,true]] as const) {
            const action = document.createElement('button');
            action.textContent = label;
            action.setAttribute('aria-label', `${label}: ${entry.name}`);
            action.onclick = () => { if (read) void this.open(entry.path, true); else void this.download(entry.path, sudo); };
            actions.append(action);
          }
          list.append(actions);
        }
      });
      if(!directory.entries.length){const empty=document.createElement('p');empty.textContent='Empty directory';list.append(empty);}
      this.status.textContent=`${directory.entries.length} entries · UTF-8 text · Maximum 1 MiB`;
    }catch(e){if(generation===this.generation)this.status.textContent=String(e);}finally{this.busy=false;}
  }
  private async open(path:string,sudo=false){
    if(sudo&&!await this.hooks.confirm('Read protected file?','Use this connection�s SSH password with sudo to read this file? Protected files open read-only.'))return;
    if(this.busy)return;this.busy=true;if(!await this.canDiscard()){this.busy=false;return;}this.area.disabled=true;const generation=this.generation;this.status.textContent='Opening file…';
    try{
      const doc=await this.request<Document>({operation:sudo?'protected_read':'read',path});if(generation!==this.generation)return;
      this.document={...doc,session:this.session,original:doc.content.replace(/\r\n/g,'\n'),crlf:doc.content.includes('\r\n')&&!/(^|[^\r])\n/.test(doc.content)};
      this.area.value=this.document.original;this.area.disabled=false;this.area.readOnly=sudo;this.refreshDirty();this.area.focus();this.status.textContent='UTF-8 · '+(this.document.crlf?'CRLF':'LF')+' · Ctrl+S to save';
    }catch(e){if(generation===this.generation)this.status.textContent=String(e);}finally{this.busy=false;this.area.disabled=!this.document;}
  }
  private async download(path:string,sudo:boolean){
    if(this.busy||this.saving)return;
    if(sudo&&!await this.hooks.confirm('Download protected file?','Use this connection�s SSH password with sudo to download this file?'))return;
    this.busy=true;this.status.textContent='Downloading�';
    try{
      const result=await this.request<{data:string}>({operation:'download',path,sudo});
      const binary=atob(result.data);
      const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
      const destination=await save({defaultPath:path.split(/[\\/]/).pop()||'download'});
      if(!destination){this.status.textContent='Download cancelled';return;}
      await writeFile(destination,bytes);
      this.status.textContent='Download saved';
    }catch(e){this.status.textContent=String(e);}finally{this.busy=false;}
  }
  private async save(){
    const doc=this.document;if(!doc||this.area.readOnly||this.saving||this.busy||!this.dirty())return;this.saving=true;this.refreshDirty();const draft=this.area.value;this.status.textContent='Saving…';
    try{
      const content=doc.crlf?draft.replace(/\n/g,'\r\n'):draft;
      const saved=await this.request<Document>({operation:'write',path:doc.path,content,revision:doc.revision});
      if(this.document===doc){doc.revision=saved.revision;doc.original=draft;this.status.textContent='Saved';}
    }catch(e){this.status.textContent=String(e);}finally{this.saving=false;this.refreshDirty();}
  }
}
