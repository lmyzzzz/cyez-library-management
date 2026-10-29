"""Small, local SVG/draw.io exporter for the record-only design atlas."""
from html import escape
import xml.etree.ElementTree as ET

BLUE = '#e8effa'
GREEN = '#e4f2eb'
PURPLE = '#eee7f8'
RED = '#fcebea'
YELLOW = '#fff4dc'


class Page:
    def __init__(self, ident, title, subtitle, width, height):
        self.ident, self.title, self.subtitle = ident, title, subtitle
        self.width, self.height = width, height
        self.nodes, self.edges = [], []

    def box(self, ident, x, y, w, h, text, fill='#ffffff',
            stroke='#cbd5e1', size=18, bold=False, align='center', kind='box'):
        node = dict(id=ident, x=x, y=y, w=w, h=h, text=text, fill=fill,
                    stroke=stroke, size=size, bold=bold, align=align, kind=kind)
        self.nodes.append(node)
        return node

    def label(self, ident, x, y, w, h, text, size=17, fill='none',
              bold=False, align='center'):
        return self.box(ident, x, y, w, h, text, fill=fill, stroke='none',
                        size=size, bold=bold, align=align, kind='label')

    def edge(self, ident, source, target, points, both=False, dashed=False, arrow=True):
        self.edges.append(dict(id=ident, source=source, target=target,
                               points=points, both=both, dashed=dashed, arrow=arrow))

    def _layers(self):
        return ([n for n in self.nodes if n['kind'] == 'panel'],
                [n for n in self.nodes if n['kind'] != 'panel'])

    @staticmethod
    def _svg_node(n):
        lines = []
        if n['fill'] != 'none' or n['stroke'] != 'none':
            lines.append(f'<rect x="{n["x"]}" y="{n["y"]}" width="{n["w"]}" height="{n["h"]}" rx="10" fill="{n["fill"]}" stroke="{n["stroke"]}" stroke-width="1.5"/>')
        text_lines = n['text'].split('\n')
        lh = n['size'] * 1.45
        x = n['x'] + (18 if n['align'] == 'left' else n['w'] / 2)
        y = n['y'] + n['h'] / 2 - (len(text_lines) - 1) * lh / 2 + n['size'] * .35
        anchor = 'start' if n['align'] == 'left' else 'middle'
        weight = '600' if n['bold'] else '400'
        for index, line in enumerate(text_lines):
            lines.append(f'<text x="{x}" y="{y + index * lh}" text-anchor="{anchor}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="{n["size"]}" font-weight="{weight}" fill="#172b4d">{escape(line)}</text>')
        return lines

    def svg_text(self):
        lines = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" viewBox="0 0 {self.width} {self.height}" role="img" aria-labelledby="title desc">',
                 f'<title id="title">{escape(self.title)}</title><desc id="desc">{escape(self.subtitle)}</desc>',
                 '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#475569"/></marker></defs>',
                 f'<rect width="{self.width}" height="{self.height}" fill="#ffffff"/>']
        panels, nodes = self._layers()
        for n in panels:
            lines.extend(self._svg_node(n))
        for e in self.edges:
            points = ' '.join(f'{x},{y}' for x, y in e['points'])
            attrs = ''
            if e['arrow']:
                attrs += ' marker-end="url(#arrow)"'
            if e['both']:
                attrs += ' marker-start="url(#arrow)"'
            if e['dashed']:
                attrs += ' stroke-dasharray="6 5"'
            lines.append(f'<polyline points="{points}" fill="none" stroke="#475569" stroke-width="2" stroke-linejoin="round"{attrs}/>')
        for n in nodes:
            lines.extend(self._svg_node(n))
        return '\n'.join(lines + ['</svg>']) + '\n'

    def export_drawio(self, mxfile):
        diagram = ET.SubElement(mxfile, 'diagram', id=self.ident, name=self.title)
        model = ET.SubElement(diagram, 'mxGraphModel', dx=str(self.width), dy=str(self.height),
                              grid='1', gridSize='10', guides='1', tooltips='1', connect='1',
                              arrows='1', fold='1', page='1', pageScale='1', pageWidth=str(self.width),
                              pageHeight=str(self.height), math='0', shadow='0')
        root = ET.SubElement(model, 'root')
        ET.SubElement(root, 'mxCell', id='0')
        ET.SubElement(root, 'mxCell', id='1', parent='0')

        def export_node(n):
            style = (f'rounded=1;whiteSpace=wrap;html=0;fillColor={n["fill"]};strokeColor={n["stroke"]};'
                     f'strokeWidth=1.5;fontColor=#172b4d;fontFamily=Microsoft YaHei;fontSize={n["size"]};'
                     f'fontStyle={int(n["bold"])};align={n["align"]};verticalAlign=middle;spacing=8;')
            cell = ET.SubElement(root, 'mxCell', id=n['id'], value=n['text'], style=style, vertex='1', parent='1')
            ET.SubElement(cell, 'mxGeometry', x=str(n['x']), y=str(n['y']),
                          width=str(n['w']), height=str(n['h']), **{'as': 'geometry'})

        panels, nodes = self._layers()
        lookup = {n['id']: n for n in self.nodes}
        for n in panels:
            export_node(n)
        for e in self.edges:
            source, target = lookup[e['source']], lookup[e['target']]
            first, last = e['points'][0], e['points'][-1]
            style = ('edgeStyle=none;rounded=0;html=0;strokeColor=#475569;strokeWidth=2;'
                     f'endArrow={"block" if e["arrow"] else "none"};endFill=1;'
                     f'startArrow={"block" if e["both"] else "none"};startFill=1;dashed={int(e["dashed"])};'
                     f'exitX={(first[0]-source["x"])/source["w"]};exitY={(first[1]-source["y"])/source["h"]};exitPerimeter=0;'
                     f'entryX={(last[0]-target["x"])/target["w"]};entryY={(last[1]-target["y"])/target["h"]};entryPerimeter=0;')
            cell = ET.SubElement(root, 'mxCell', id=e['id'], edge='1', parent='1', source=e['source'], target=e['target'], style=style)
            geometry = ET.SubElement(cell, 'mxGeometry', relative='1', **{'as': 'geometry'})
            ET.SubElement(geometry, 'mxPoint', x=str(first[0]), y=str(first[1]), **{'as': 'sourcePoint'})
            ET.SubElement(geometry, 'mxPoint', x=str(last[0]), y=str(last[1]), **{'as': 'targetPoint'})
            if len(e['points']) > 2:
                waypoints = ET.SubElement(geometry, 'Array', attrib={'as': 'points'})
                for x, y in e['points'][1:-1]:
                    ET.SubElement(waypoints, 'mxPoint', x=str(x), y=str(y))
        for n in nodes:
            export_node(n)


def page(ident, title, subtitle, width, height):
    p = Page(ident, title, subtitle, width, height)
    p.label('title', 25, 15, width-50, 52, title, 30, bold=True, align='left')
    p.label('subtitle', 25, 68, width-50, 36, subtitle, 17, align='left')
    return p


def panel(p, ident, x, y, w, h, title, fill=BLUE):
    node = p.box(ident, x, y, w, h, '', fill=fill, kind='panel')
    p.label(ident+'-title', x+15, y+10, w-30, 45, title, 23, bold=True)
    return node


def route(p, ident, source, target, points, **kwargs):
    p.edge(ident, source, target, points, **kwargs)


def down(p, ident, source, target, label=None, **kwargs):
    lookup = {n['id']: n for n in p.nodes}
    a, b = lookup[source], lookup[target]
    x1, y1 = a['x'] + a['w']/2, a['y'] + a['h']
    x2, y2 = b['x'] + b['w']/2, b['y']
    mid = (y1+y2)/2
    points = [(x1, y1), (x2, y2)] if x1 == x2 else [(x1, y1), (x1, mid), (x2, mid), (x2, y2)]
    route(p, ident, source, target, points, **kwargs)
    if label:
        p.label(ident+'-label', (x1+x2)/2-170, mid-23, 340, 46, label, fill='#ffffff')


def validate(p):
    ids = [item['id'] for item in p.nodes + p.edges]
    assert len(ids) == len(set(ids)), (p.ident, 'duplicate ID')
    nodes = {n['id'] for n in p.nodes}
    for n in p.nodes:
        assert n['w'] > 0 and n['h'] > 0, (p.ident, n['id'], 'invalid size')
        assert 0 <= n['x'] <= p.width-n['w'] and 0 <= n['y'] <= p.height-n['h'], (p.ident, n['id'], 'outside canvas')
    for e in p.edges:
        assert e['source'] in nodes and e['target'] in nodes, (p.ident, e['id'], 'unknown node')
        assert len(e['points']) >= 2, (p.ident, e['id'], 'missing route')
