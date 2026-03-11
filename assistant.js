const fs = require("fs")
const path = require("path")

const cubismCode = fs.readFileSync(
  path.join(__dirname, "live2dcubismcore.min.js"),
  "utf8"
)
eval(cubismCode)

const PIXI = require("pixi.js")
const { Live2DModel } = require("pixi-live2d-display/cubism4")

const app = new PIXI.Application({
  view: document.getElementById("assistant-canvas"),
  width: 200,
  height: 200,
  backgroundAlpha: 0
})

let model

;(async () => {

  model = await Live2DModel.from("./model/ai_assistant_model.model3.json")

  app.stage.addChild(model)

  model.anchor.set(0.5,1)
  model.x = 100
  model.y = 200
  model.scale.set(0.15)

})()