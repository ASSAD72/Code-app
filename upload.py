from flask import Flask, request
app = Flask(__name__)
@app.route('/', methods=['GET', 'POST'])
def upload():
    if request.method == 'POST':
        f = request.files['file']
        f.save('project.zip')
        return '<h1>تم الرفع بنجاح! ارجع للـ Terminal</h1>'
    return '<form method="POST" enctype="multipart/form-data"><input type="file" name="file"><input type="submit" value="رفع"></form>'
app.run(host='0.0.0.0', port=5000)
