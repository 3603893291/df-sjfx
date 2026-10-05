(async function(){
  var out={};
  var list=await window.df.plugin.list();
  var id=((list.plugins||[])[0]||{}).id;
  out.id=id;
  out.setEnabled=await window.df.plugin.setEnabled(id,true);
  var p=await window.df.plugin.page(id);
  out.pageOk=!!(p&&p.ok); out.htmlLen=p&&p.html?p.html.length:0;
  out.pageErr=(p&&p.error)||'';
  var info=await window.df.plugin.call(id,'host.info',{});
  out.callOk=!!(info&&info.ok!==false); out.callRaw=JSON.stringify(info).slice(0,160);
  return JSON.stringify(out,null,1);
})()
